import {
  ChefError,
  ChefMemory,
  ChefMemoryDraft,
  InboxMessage,
  ThreadId,
  WorkTask,
  type InboxSubjectContext,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { decodeSubjectContext } from "../inbox/subjectContext.ts";
import * as Runtime from "./ChefRuntime.ts";
import { scopeApplies } from "./chefDecision.ts";

export interface ChefSubject {
  readonly id: string;
  readonly sequence: number;
  readonly title: string;
  readonly summary: string;
  readonly actionVersion: number;
  readonly taskId: string | null;
  readonly closedAt: string | null;
  readonly context: InboxSubjectContext | null;
  readonly contextUncertain: boolean;
}
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(InboxMessage));
const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkTask));
const decodeMemory = Schema.decodeUnknownEffect(Schema.fromJsonString(ChefMemory));
const decodeDraft = Schema.decodeEffect(Schema.fromJsonString(ChefMemoryDraft));

export const readSubject = Effect.fn(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Omit<ChefSubject, "context"> & { contextJson: string | null }>`SELECT
    id,sequence,title,summary,action_version AS actionVersion,task_id AS taskId,
    closed_at AS closedAt,context_json AS contextJson,context_uncertain AS contextUncertain
    FROM inbox_subjects WHERE id=${id}`;
  if (!row) return yield* new ChefError({ reason: "missing" });
  const { contextJson, ...subject } = row;
  return {
    ...subject,
    contextUncertain: Boolean(row.contextUncertain),
    context: contextJson ? yield* decodeSubjectContext(contextJson) : null,
  };
});

export const readContext = Effect.fn(function* (subject: ChefSubject) {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* Runtime.ChefRuntime;
  const [memoryState] = yield* sql<{
    revision: number;
  }>`SELECT memory_revision AS revision FROM chef_global WHERE id=1`;
  const entries = yield* sql<{
    payload_json: string;
  }>`SELECT m.payload_json FROM inbox_subject_entries e
    JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=${subject.id} ORDER BY m.sequence DESC LIMIT 21`;
  const messages = yield* Effect.forEach(entries.slice(0, 20), (r) =>
    decodeMessage(r.payload_json),
  );
  const senders = [
    ...new Set(
      messages.map(({ source }) =>
        source.kind === "gmail"
          ? `gmail:${(source.message.sender.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? source.message.sender).toLowerCase()}`
          : `slack:${source.message.workspaceId}:${source.message.authorId}`,
      ),
    ),
  ];
  let projectId = subject.context?.projectId ?? null;
  let chantierId = subject.context?.kind === "chantier" ? subject.context.id : null;
  const targetTaskId =
    subject.taskId ?? (subject.context?.kind === "task" ? subject.context.id : null);
  const [linked] = targetTaskId
    ? yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM work_tasks WHERE id=${targetTaskId}`
    : [];
  const linkedTask = linked ? yield* decodeTask(linked.payload_json) : null;
  if (linkedTask) {
    projectId = linkedTask.projectId;
    chantierId = linkedTask.chantierId ?? null;
  }
  const target = { context: subject.context, projectId, chantierId, senders };
  const labels = yield* targetLabels(projectId, chantierId);
  const taskRows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM work_tasks
    WHERE json_extract(payload_json,'$.status') NOT IN ('done','rejected','merged')
    AND (${projectId} IS NULL OR json_extract(payload_json,'$.projectId')=${projectId})
    AND (${chantierId} IS NULL OR json_extract(payload_json,'$.chantierId')=${chantierId})
    ORDER BY CASE WHEN id=${targetTaskId} THEN 0 ELSE 1 END,rowid DESC LIMIT 101`;
  const tasks = yield* Effect.forEach(taskRows.slice(0, 100), (r) => decodeTask(r.payload_json));
  const tokens =
    subject.title
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.slice(0, 6) ?? [];
  const textMatches = tokens.length
    ? sql.or(
        tokens.map(
          (token) => sql`lower(t.title) LIKE ${`%${token}%`}
    OR EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id=t.thread_id
    AND lower(json_extract(m.payload_json,'$.text')) LIKE ${`%${token}%`})`,
        ),
      )
    : sql`1=0`;
  const linkedThreads = tasks.flatMap((task) => (task.agentThreadId ? [task.agentThreadId] : []));
  const threadRows = yield* sql<{ id: string; title: string; projectId: string }>`SELECT
    t.thread_id AS id,t.title,t.project_id AS projectId FROM orchestration_v2_projection_threads t
    WHERE t.deleted_at IS NULL AND t.thread_id NOT LIKE 'chef-dossier:%'
    AND (${projectId} IS NULL OR t.project_id=${projectId}) AND (
      ${linkedThreads.length ? sql.in("thread_id", linkedThreads) : sql`1=0`} OR ${textMatches})
    ORDER BY CASE WHEN ${linkedThreads.length ? sql.in("thread_id", linkedThreads) : sql`1=0`} THEN 0 ELSE 1 END,
    t.updated_at DESC LIMIT 6`;
  const threads = yield* Effect.forEach(
    threadRows.slice(0, 5),
    (row) =>
      runtime.conversation(ThreadId.make(row.id)).pipe(
        Effect.map((history) => ({ ...row, ...history })),
        Effect.catchTags({
          ChefError: () =>
            Effect.succeed({ ...row, text: "Discussion indisponible", truncated: true }),
        }),
      ),
    { concurrency: 3 },
  );
  const memoryRows = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM chef_memory WHERE enabled=1 AND (
    scope_kind='global' OR (scope_kind='project' AND scope_id=${projectId})
    OR (scope_kind='chantier' AND scope_id=${chantierId})
    OR (scope_kind='sender' AND ${senders.length ? sql.in("scope_id", senders) : sql`1=0`})
    ) AND (json_extract(payload_json,'$.kind')='rule' OR scope_kind!='global' OR
      ${tokens.length ? sql.or(tokens.map((token) => sql`lower(json_extract(payload_json,'$.text')) LIKE ${`%${token}%`}`)) : sql`1=0`})
    ORDER BY sequence DESC LIMIT 101`;
  if (memoryRows.length > 100) return yield* new ChefError({ reason: "limit" });
  const memories = (yield* Effect.forEach(memoryRows, (r) => decodeMemory(r.payload_json))).filter(
    (memory) => scopeApplies(memory.scope, target),
  );
  const families = yield* sql<{ draft: string; example: string; cases: number }>`SELECT
    json_extract(d.payload_json,'$.memory') AS draft,json_extract(d.payload_json,'$.items[0].subjectTitle') AS example,
    json_array_length(d.payload_json,'$.items') AS cases FROM chef_decisions d JOIN agent_requests r ON r.id=d.request_id
    WHERE d.state='pending' AND json_extract(r.payload_json,'$.status')='pending'
    AND json_extract(d.payload_json,'$.memory.kind')='rule' AND (
      json_extract(d.payload_json,'$.memory.scope.kind')='global'
      OR (json_extract(d.payload_json,'$.memory.scope.kind')='project' AND json_extract(d.payload_json,'$.memory.scope.id')=${projectId})
      OR (json_extract(d.payload_json,'$.memory.scope.kind')='chantier' AND json_extract(d.payload_json,'$.memory.scope.id')=${chantierId})
      OR (json_extract(d.payload_json,'$.memory.scope.kind')='sender' AND
        ${senders.length ? sql.or(senders.map((s) => sql`json_extract(d.payload_json,'$.memory.scope.id')=${s}`)) : sql`1=0`}))
    ORDER BY d.created_at DESC LIMIT 20`;
  const pendingFamilies = yield* Effect.forEach(families, (r) =>
    decodeDraft(r.draft).pipe(
      Effect.map((memory) => ({ memory, example: r.example, cases: r.cases })),
    ),
  );
  const responsible = yield* responsibleFor(projectId, chantierId);
  const chefDirectory = yield* sql<{
    id: string;
    name: string;
    projectId: string | null;
    chantierId: string | null;
    projectTitle: string | null;
    threadId: string | null;
    paused: number;
  }>`SELECT a.id,json_extract(a.payload_json,'$.name') AS name,
    json_extract(a.payload_json,'$.projectId') AS projectId,
    json_extract(a.payload_json,'$.chantierId') AS chantierId,p.title AS projectTitle,
    json_extract(a.payload_json,'$.currentThreadId') AS threadId,
    json_extract(a.payload_json,'$.paused') AS paused
    FROM autonomous_agents a LEFT JOIN projection_projects p
      ON p.project_id=json_extract(a.payload_json,'$.projectId')
    WHERE COALESCE(json_extract(a.payload_json,'$.archived'),0)=0
      AND json_extract(a.payload_json,'$.kind') IN ('chef','chantier-chef')
    ORDER BY a.id LIMIT 101`;
  return {
    subject,
    target,
    labels,
    tasks,
    linkedTask,
    threads,
    memories,
    pendingFamilies,
    memoryRevision: memoryState!.revision,
    responsible: responsible ?? null,
    chefDirectory: chefDirectory.slice(0, 100),
    chefDirectoryIncomplete: chefDirectory.length > 100,
    searchIncomplete: taskRows.length > 100 || threadRows.length > 5,
    sourcesIncomplete:
      entries.length > 20 || messages.some((m) => m.source.message.text.length > 2400),
    sources: messages.map((message) => ({
      id: message.id,
      url: message.url,
      source: {
        ...message.source,
        message: { ...message.source.message, text: message.source.message.text.slice(0, 2400) },
      },
      qualification: message.qualification?.category,
      truncated: message.source.message.text.length > 2400,
    })),
  };
});
export type ChefContext = Effect.Success<ReturnType<typeof readContext>>;

export const targetLabels = Effect.fn(function* (
  projectId: string | null,
  chantierId: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const [labels] = yield* sql<{ projectTitle: string | null; chantierTitle: string | null }>`SELECT
    (SELECT title FROM projection_projects WHERE project_id=${projectId}) AS projectTitle,
    (SELECT json_extract(payload_json,'$.title') FROM work_chantiers WHERE id=${chantierId}) AS chantierTitle`;
  return labels!;
});

export const responsibleFor = Effect.fn(function* (
  projectId: string | null,
  chantierId: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const [responsible] = yield* sql<{ id: string; name: string; paused: number }>`SELECT id,
    json_extract(payload_json,'$.name') AS name,json_extract(payload_json,'$.paused') AS paused
    FROM autonomous_agents WHERE COALESCE(json_extract(payload_json,'$.archived'),0)=0 AND (
      (${chantierId} IS NOT NULL AND json_extract(payload_json,'$.kind')='chantier-chef'
        AND json_extract(payload_json,'$.chantierId')=${chantierId})
      OR (${projectId} IS NOT NULL AND json_extract(payload_json,'$.kind')='chef'
        AND json_extract(payload_json,'$.projectId')=${projectId}))
    ORDER BY CASE WHEN json_extract(payload_json,'$.kind')='chantier-chef' THEN 0 ELSE 1 END,id LIMIT 1`;
  return responsible ?? null;
});
