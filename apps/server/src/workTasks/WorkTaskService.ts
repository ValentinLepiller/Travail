import { validateTaskDependencies } from "./taskDependencies.ts";
import { GmailTaskMessage, gmailMessageUrl } from "./gmailTaskRules.ts";
import { reservedWorkTasks } from "./reservations.ts";
import {
  WorkTask,
  WorkChantier,
  workTaskBlockers,
  type WorkChantierSaveInput,
  type WorkChantierPlanInput,
  type WorkChantierClaimInput,
  isClosedWorkTaskStatus,
  ProjectId,
  type ThreadId,
  type WorkTaskClaimInput,
  type WorkQualificationReserveInput,
  WorkTaskTypesConfig,
  WorkTaskError,
  SlackTaskMessage,
  type WorkTaskSaveInput,
  type WorkTaskDeleteInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

export class WorkTaskService extends Context.Service<
  WorkTaskService,
  {
    readonly listChantiers: () => Effect.Effect<ReadonlyArray<WorkChantier>, WorkTaskError>;
    readonly subscribeChantiers: () => Stream.Stream<ReadonlyArray<WorkChantier>, WorkTaskError>;
    readonly readChantier: (id: string) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly saveChantier: (
      input: WorkChantierSaveInput,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly claimChantier: (
      threadId: ThreadId,
      input: typeof WorkChantierClaimInput.Type,
      release?: boolean,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly applyPlan: (
      input: WorkChantierPlanInput,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly assertCanStart: (
      task: WorkTask,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<void, WorkTaskError>;
    readonly read: (id: string) => Effect.Effect<WorkTask, WorkTaskError>;
    readonly claim: (
      threadId: ThreadId,
      input: WorkTaskClaimInput,
      release?: boolean,
    ) => Effect.Effect<WorkTask, WorkTaskError>;
    readonly types: () => Effect.Effect<WorkTaskTypesConfig, WorkTaskError>;
    readonly subscribeTypes: () => Stream.Stream<WorkTaskTypesConfig, WorkTaskError>;
    readonly saveTypes: (input: WorkTaskTypesConfig) => Effect.Effect<void, WorkTaskError>;
    readonly list: () => Effect.Effect<ReadonlyArray<WorkTask>, WorkTaskError>;
    readonly subscribe: () => Stream.Stream<ReadonlyArray<WorkTask>, WorkTaskError>;
    readonly messages: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<SlackTaskMessage>, WorkTaskError>;
    readonly subscribeMessages: (
      id: string,
    ) => Stream.Stream<ReadonlyArray<SlackTaskMessage>, WorkTaskError>;
    readonly save: (
      input: WorkTaskSaveInput,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<WorkTask, WorkTaskError>;
    readonly reserveQualification: (
      input: WorkQualificationReserveInput,
      callerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<WorkTaskClaimInput>, WorkTaskError>;
    readonly completeForSettledThread: (threadId: ThreadId) => Effect.Effect<void, WorkTaskError>;
    readonly delete: (input: WorkTaskDeleteInput) => Effect.Effect<void, WorkTaskError>;
    readonly ingestGmail: (
      input: GmailTaskMessage,
    ) => Effect.Effect<"created" | "duplicate", WorkTaskError>;
    readonly ingestSlack: (
      input: SlackTaskMessage,
    ) => Effect.Effect<"created" | "appended" | "duplicate", WorkTaskError>;
  }
>()("t3/workTasks/WorkTaskService") {}

const isWorkTaskError = Schema.is(WorkTaskError);
const validateGmailMessage = Schema.decodeEffect(GmailTaskMessage);
const validateMessage = Schema.decodeEffect(SlackTaskMessage);
const taskIdsCodec = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeTaskIds = Schema.decodeUnknownEffect(taskIdsCodec);
const encodeTaskIds = Schema.encodeEffect(taskIdsCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reservations = reservedWorkTasks.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const revision = yield* SubscriptionRef.make(0);
  const codec = Schema.fromJsonString(WorkTask);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const messageCodec = Schema.fromJsonString(SlackTaskMessage);
  const decodeMessage = Schema.decodeUnknownEffect(messageCodec);
  const encodeMessage = Schema.encodeEffect(messageCodec);
  const encodeGmailMessage = Schema.encodeEffect(Schema.fromJsonString(GmailTaskMessage));
  const storageError = () => new WorkTaskError({ reason: "storage" });
  const changed = SubscriptionRef.update(revision, (value) => value + 1);

  const assertChantierAccess = Effect.fn(function* (callerThreadId?: ThreadId) {
    if (!callerThreadId) return;
    const runs = yield* sql`SELECT r.thread_id FROM autonomous_agent_runs r
      JOIN autonomous_agents a ON a.id = r.agent_id
      WHERE r.thread_id = ${callerThreadId}
        AND (json_extract(a.payload_json, '$.trigger') IN ('unqualified', 'todo') OR json_extract(a.payload_json, '$.kind') = 'chef') LIMIT 1`.pipe(
      Effect.mapError(storageError),
    );
    if (runs.length) return yield* new WorkTaskError({ reason: "chantierScope" });
  });

  const typesCodec = Schema.fromJsonString(WorkTaskTypesConfig);
  const decodeTypes = Schema.decodeEffect(typesCodec);
  const encodeTypes = Schema.encodeEffect(typesCodec);
  const types = () =>
    sql<{ payload_json: string }>`SELECT payload_json FROM work_task_types WHERE id = 1`.pipe(
      Effect.flatMap((rows) => decodeTypes(rows[0]!.payload_json)),
      Effect.mapError(storageError),
    );
  const saveTypes = Effect.fn(function* (input: WorkTaskTypesConfig) {
    if (new Set(input.types.map((t) => t.id)).size !== input.types.length)
      return yield* new WorkTaskError({ reason: "conflict" });
    const payload = yield* encodeTypes({
      ...input,
      version: input.version + 1,
    }).pipe(Effect.mapError(storageError));
    const rows =
      yield* sql`UPDATE work_task_types SET payload_json = ${payload} WHERE id = 1 AND json_extract(payload_json, '$.version') = ${input.version} RETURNING id`.pipe(
        Effect.mapError(storageError),
      );
    if (!rows.length) return yield* new WorkTaskError({ reason: "conflict" });
    yield* changed;
  });
  const list = Effect.fn("WorkTaskService.list")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_tasks ORDER BY rowid DESC`.pipe(Effect.mapError(storageError));
    return yield* Effect.forEach(rows, (row) =>
      decode(row.payload_json).pipe(Effect.mapError(storageError)),
    );
  });

  const messages = Effect.fn("WorkTaskService.messages")(function* (id: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_task_slack_messages
      WHERE task_id IN (
        SELECT ${id} UNION SELECT value FROM work_tasks, json_each(work_tasks.payload_json, '$.mergedTaskIds') WHERE work_tasks.id = ${id}
      ) AND EXISTS (SELECT 1 FROM work_tasks WHERE id = ${id})
      ORDER BY message_ts`.pipe(Effect.mapError(storageError));
    return yield* Effect.forEach(rows, (row) =>
      decodeMessage(row.payload_json).pipe(Effect.mapError(storageError)),
    );
  });

  const read = Effect.fn("WorkTaskService.read")(function* (id: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_tasks WHERE id = ${id}`.pipe(Effect.mapError(storageError));
    if (!rows[0]) return yield* new WorkTaskError({ reason: "conflict" });
    return yield* decode(rows[0].payload_json).pipe(Effect.mapError(storageError));
  });
  const chantierCodec = Schema.fromJsonString(WorkChantier);
  const decodeChantier = Schema.decodeUnknownEffect(chantierCodec);
  const encodeChantier = Schema.encodeEffect(chantierCodec);
  const domainError = (cause: unknown) => (isWorkTaskError(cause) ? cause : storageError());
  const reserveQualification = Effect.fn("WorkTaskService.reserveQualification")(function* (
    input: WorkQualificationReserveInput,
    callerThreadId: ThreadId,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const runs = yield* sql<{
            task_id: string | null;
            task_ids_json: string;
            project_id: string | null;
          }>`SELECT r.task_id, r.task_ids_json, json_extract(a.payload_json, '$.projectId') AS project_id
        FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id = r.agent_id
        WHERE r.thread_id = ${callerThreadId} AND r.finished_at IS NULL
          AND json_extract(a.payload_json, '$.trigger') = 'unqualified'
          AND json_extract(a.payload_json, '$.currentThreadId') = ${callerThreadId}
          AND json_extract(a.payload_json, '$.paused') = 0`;
          const run = runs[0];
          if (!run?.task_id) return yield* new WorkTaskError({ reason: "agent" });
          const previous = yield* decodeTaskIds(run.task_ids_json);
          const ids = [
            ...new Set([run.task_id, ...previous, ...input.tasks.map((task) => task.id)]),
          ];
          if (
            !input.tasks.length ||
            ids.length > 20 ||
            new Set(input.tasks.map((task) => task.id)).size !== input.tasks.length
          )
            return yield* new WorkTaskError({ reason: "conflict" });
          const reserved = yield* reservations;
          const projects = new Set<string>();
          if (run.project_id) projects.add(run.project_id);
          const cards = yield* Effect.forEach(ids, (id) => read(id));
          for (const task of cards) {
            if (task.projectId) projects.add(task.projectId);
            const expected = input.tasks.find((item) => item.id === task.id);
            if (
              task.chantierId ||
              task.agentThreadId ||
              (expected &&
                (task.status !== "unqualified" || task.version !== expected.expectedVersion)) ||
              reserved.some((item) => item.task_id === task.id && item.thread_id !== callerThreadId)
            )
              return yield* new WorkTaskError({ reason: "conflict" });
          }
          if (projects.size > 1) return yield* new WorkTaskError({ reason: "project" });
          const payload = yield* encodeTaskIds(ids);
          if (payload !== run.task_ids_json)
            yield* sql`UPDATE autonomous_agent_runs SET task_ids_json = ${payload} WHERE thread_id = ${callerThreadId}`;
          return cards.map((task) => ({ id: task.id, expectedVersion: task.version }));
        }),
      )
      .pipe(Effect.mapError(domainError));
  });
  const listChantiers = Effect.fn("WorkTaskService.listChantiers")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_chantiers ORDER BY rowid DESC`;
    return yield* Effect.forEach(rows, (row) => decodeChantier(row.payload_json));
  }, Effect.mapError(domainError));
  const readChantier = Effect.fn("WorkTaskService.readChantier")(function* (id: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_chantiers WHERE id = ${id}`;
    if (!rows[0]) return yield* new WorkTaskError({ reason: "conflict" });
    return yield* decodeChantier(rows[0].payload_json);
  }, Effect.mapError(domainError));
  const saveChantierInternal = Effect.fn("WorkTaskService.saveChantier")(function* (
    input: WorkChantierSaveInput,
    plan = false,
  ) {
    const next = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM work_chantiers WHERE id = ${input.id}`;
          const previous = rows[0] ? yield* decodeChantier(rows[0].payload_json) : null;
          if ((previous?.version ?? 0) !== input.expectedVersion)
            return yield* new WorkTaskError({ reason: "conflict" });
          const projects =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL`;
          if (
            !projects.length ||
            (previous?.orchestratorThreadId && previous.projectId !== input.projectId)
          )
            return yield* new WorkTaskError({ reason: "project" });
          if (
            new Set(input.externalDependencies.map((item) => item.id)).size !==
            input.externalDependencies.length
          )
            return yield* new WorkTaskError({ reason: "dependencies" });
          const now = DateTime.formatIso(yield* DateTime.now);
          const { expectedVersion, ...fields } = input;
          const chantier: WorkChantier = {
            ...fields,
            version: expectedVersion + 1,
            orchestratorThreadId: previous?.orchestratorThreadId ?? null,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };
          if (!plan) {
            const error = validateTaskDependencies(
              (yield* list()).map((t) => ({ ...t, expectedVersion: t.version })),
              [...(yield* listChantiers()).filter((c) => c.id !== chantier.id), chantier],
            );
            if (error) return yield* error;
          }
          yield* sql`INSERT INTO work_chantiers (id, version, payload_json) VALUES (${chantier.id}, ${chantier.version}, ${yield* encodeChantier(chantier)})
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload_json = excluded.payload_json`;
          return chantier;
        }),
      )
      .pipe(Effect.mapError(domainError));
    if (!plan) yield* changed;
    return next;
  });
  const saveChantier = Effect.fn(function* (
    input: WorkChantierSaveInput,
    callerThreadId?: ThreadId,
  ) {
    yield* assertChantierAccess(callerThreadId);
    return yield* saveChantierInternal(input);
  });
  const claimChantier = Effect.fn("WorkTaskService.claimChantier")(function* (
    threadId: ThreadId,
    input: typeof WorkChantierClaimInput.Type,
    release = false,
  ) {
    yield* assertChantierAccess(threadId);
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const chantier = yield* readChantier(input.id);
          const threads = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND project_id = ${chantier.projectId} AND deleted_at IS NULL`;
          if (!threads.length) return yield* new WorkTaskError({ reason: "agent" });
          if (chantier.orchestratorThreadId && chantier.orchestratorThreadId !== threadId)
            return yield* new WorkTaskError({ reason: "conflict" });
          if (chantier.version !== input.expectedVersion)
            return yield* new WorkTaskError({ reason: "conflict" });
          const next = {
            ...chantier,
            orchestratorThreadId: release ? null : threadId,
            version: chantier.version + 1,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* sql`UPDATE work_chantiers SET version = ${next.version}, payload_json = ${yield* encodeChantier(next)} WHERE id = ${next.id}`;
          return next;
        }),
      )
      .pipe(Effect.mapError(domainError));
    yield* changed;
    return result;
  });
  const assertChefScope = Effect.fn(function* (
    projectId: WorkTask["projectId"],
    callerThreadId?: ThreadId,
  ) {
    if (callerThreadId) {
      const chefs = yield* sql<{
        project_id: string | null;
        paused: number;
      }>`SELECT json_extract(a.payload_json, '$.projectId') AS project_id, json_extract(a.payload_json, '$.paused') AS paused
        FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id = r.agent_id
        WHERE r.thread_id = ${callerThreadId} AND json_extract(a.payload_json, '$.kind') = 'chef'`.pipe(
        Effect.mapError(storageError),
      );
      if (chefs.some((chef) => chef.paused || !chef.project_id || chef.project_id !== projectId))
        return yield* new WorkTaskError({ reason: "project" });
    }
  });
  const assertCanStart = Effect.fn("WorkTaskService.assertCanStart")(function* (
    task: WorkTask,
    callerThreadId?: ThreadId,
  ) {
    yield* assertChefScope(task.projectId, callerThreadId);
    if (task.chantierId) yield* assertChantierAccess(callerThreadId);
    if (!task.chantierId && !task.dependsOn?.length && !task.externalDependsOn?.length) return;
    const chantier = task.chantierId ? yield* readChantier(task.chantierId) : null;
    if (chantier && chantier.status !== "active")
      return yield* new WorkTaskError({ reason: "preparation" });
    if (workTaskBlockers(task, yield* list(), chantier?.externalDependencies).length)
      return yield* new WorkTaskError({ reason: "dependencies" });
  });
  const applyPlan = Effect.fn("WorkTaskService.applyPlan")(function* (
    input: WorkChantierPlanInput,
    callerThreadId?: ThreadId,
  ) {
    yield* assertChantierAccess(callerThreadId);
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (new Set(input.tasks.map((t) => t.id)).size !== input.tasks.length)
            return yield* new WorkTaskError({ reason: "conflict" });
          const existing = yield* list();
          for (const task of input.tasks) {
            const previous = existing.find((item) => item.id === task.id);
            if (
              task.chantierId !== input.chantier.id ||
              task.projectId !== input.chantier.projectId ||
              (previous?.chantierId && previous.chantierId !== input.chantier.id)
            )
              return yield* new WorkTaskError({ reason: "project" });
          }
          const chantier = yield* saveChantierInternal(input.chantier, true);
          const finalTasks = new Map<string, WorkTaskSaveInput>(
            existing.map((t) => [t.id, { ...t, expectedVersion: t.version }]),
          );
          for (const task of input.tasks)
            finalTasks.set(task.id, { ...finalTasks.get(task.id), ...task });
          const graph = [...finalTasks.values()];
          const error = validateTaskDependencies(graph, yield* listChantiers());
          if (error) return yield* error;
          for (const task of input.tasks) yield* saveInternal(task, callerThreadId, graph);
          return chantier;
        }),
      )
      .pipe(Effect.mapError(domainError));
    yield* changed;
    return result;
  });

  const saveInternal = Effect.fn("WorkTaskService.save")(function* (
    input: WorkTaskSaveInput,
    callerThreadId?: ThreadId,
    plannedTasks?: ReadonlyArray<WorkTaskSaveInput>,
  ) {
    const task = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (callerThreadId) {
            const runs = yield* sql<{
              owns_task: number;
            }>`SELECT (r.task_id = ${input.id} OR EXISTS (SELECT 1 FROM json_each(r.task_ids_json) WHERE value = ${input.id})) AS owns_task
              FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id = r.agent_id
              WHERE r.thread_id = ${callerThreadId}
                AND json_extract(a.payload_json, '$.trigger') = 'unqualified'`;
            if (runs[0]) {
              if (input.status === "ready")
                return yield* new WorkTaskError({ reason: "preparation" });
              if (!runs[0].owns_task) return yield* new WorkTaskError({ reason: "conflict" });
            }
          }
          if (input.projectId !== null) {
            const projects =
              yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL`;
            if (projects.length === 0) return yield* new WorkTaskError({ reason: "project" });
          }
          if (input.agentThreadId !== null) {
            const agents = yield* sql`SELECT project_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${input.agentThreadId} AND deleted_at IS NULL
          AND (${input.projectId} IS NULL OR project_id = ${input.projectId})`;
            if (agents.length === 0) return yield* new WorkTaskError({ reason: "agent" });
          }
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM work_tasks WHERE id = ${input.id}`;
          const previous = rows[0] ? yield* decode(rows[0].payload_json) : null;
          yield* assertChefScope(input.projectId, callerThreadId);
          if (previous) yield* assertChefScope(previous.projectId, callerThreadId);
          if (previous?.chantierId || input.chantierId) yield* assertChantierAccess(callerThreadId);
          if (
            (previous?.version ?? 0) !== input.expectedVersion ||
            (!previous && input.expectedVersion !== 0)
          ) {
            return yield* new WorkTaskError({ reason: "conflict" });
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const next: WorkTask = {
            id: input.id,
            typeId: input.typeId ?? null,
            mergedTaskIds: input.mergedTaskIds ?? previous?.mergedTaskIds ?? [],
            chantierId:
              input.chantierId === undefined ? (previous?.chantierId ?? null) : input.chantierId,
            sources: input.sources ?? previous?.sources ?? [],
            dependsOn: input.dependsOn ?? previous?.dependsOn ?? [],
            externalDependsOn: input.externalDependsOn ?? previous?.externalDependsOn ?? [],
            milestone: input.milestone ?? previous?.milestone ?? "",
            acceptanceCriteria: input.acceptanceCriteria ?? previous?.acceptanceCriteria ?? "",
            title: input.title,
            notes: input.notes,
            status: input.status,
            projectId: input.projectId,
            agentThreadId: input.agentThreadId,
            dueDate: input.dueDate,
            version: input.expectedVersion + 1,
            qualifiedAt:
              previous?.qualifiedAt ??
              (input.status === "todo" && (!previous || previous.status === "unqualified")
                ? now
                : null),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };
          const all =
            plannedTasks ??
            (yield* list())
              .filter((item) => item.id !== next.id)
              .map((item) => ({ ...item, expectedVersion: item.version }))
              .concat({ ...next, expectedVersion: next.version });
          if (!plannedTasks) {
            const error = validateTaskDependencies(all, yield* listChantiers());
            if (error) return yield* error;
          }
          if (
            (next.status === "doing" || next.status === "done") &&
            previous?.status !== next.status
          ) {
            const chantier = next.chantierId ? yield* readChantier(next.chantierId) : null;
            if (next.status === "doing" && chantier && chantier.status !== "active")
              return yield* new WorkTaskError({ reason: "preparation" });
            if (workTaskBlockers(next, all, chantier?.externalDependencies).length)
              return yield* new WorkTaskError({ reason: "dependencies" });
          }
          yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${next.id}, ${next.version}, ${yield* encode(next)})
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload_json = excluded.payload_json`;
          return next;
        }),
      )
      .pipe(Effect.mapError((cause) => (isWorkTaskError(cause) ? cause : storageError())));
    if (!plannedTasks) yield* changed;
    return task;
  });
  const groupQualification = Effect.fn("WorkTaskService.groupQualification")(function* (
    input: WorkTaskSaveInput,
    callerThreadId?: ThreadId,
  ) {
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (!callerThreadId) return yield* new WorkTaskError({ reason: "agent" });
          const runs = yield* sql<{
            task_id: string | null;
            project_id: string | null;
          }>`SELECT r.task_id, json_extract(a.payload_json, '$.projectId') AS project_id
        FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id = r.agent_id
        WHERE r.thread_id = ${callerThreadId} AND json_extract(a.payload_json, '$.trigger') = 'unqualified'
          AND (r.task_id = ${input.id} OR EXISTS (SELECT 1 FROM json_each(r.task_ids_json) WHERE value = ${input.id}))
          AND json_extract(a.payload_json, '$.currentThreadId') = ${callerThreadId}
          AND json_extract(a.payload_json, '$.paused') = 0`;
          if (!runs[0] || !["unqualified", "todo", "rejected"].includes(input.status))
            return yield* new WorkTaskError({ reason: "conflict" });
          const members = input.qualificationGroup ?? [];
          const ids = [input.id, ...members.map((member) => member.id)];
          if (new Set(ids).size !== ids.length)
            return yield* new WorkTaskError({ reason: "conflict" });
          const all = yield* list();
          const seed = yield* read(input.id);
          const grouped = yield* Effect.forEach(members, (member) => read(member.id));
          const versions = [
            input.expectedVersion,
            ...members.map((member) => member.expectedVersion),
          ];
          const tasks = [seed, ...grouped];
          if (input.chantierId || tasks.some((task) => task.chantierId))
            yield* assertChantierAccess(callerThreadId);
          for (const [index, task] of tasks.entries()) {
            if (
              task.status !== "unqualified" ||
              task.version !== versions[index] ||
              task.agentThreadId ||
              (runs[0].project_id !== null && task.projectId !== runs[0].project_id) ||
              (task.projectId !== null && task.projectId !== input.projectId) ||
              (task.chantierId ?? null) !== (seed.chantierId ?? null)
            )
              return yield* new WorkTaskError({ reason: "conflict" });
          }
          const reserved = yield* reservations;
          for (const member of grouped) {
            if (
              reserved.some(
                (item) => item.task_id === member.id && item.thread_id !== callerThreadId,
              ) ||
              all.some((task) => task.dependsOn?.includes(member.id))
            )
              return yield* new WorkTaskError({ reason: "conflict" });
          }
          const sources = [
            ...new Map(
              tasks
                .flatMap((task) => task.sources ?? [])
                .concat(input.sources ?? [])
                .map((source) => [JSON.stringify(source), source]),
            ).values(),
          ];
          const mergedTaskIds = [
            ...new Set(
              tasks
                .flatMap((task) => task.mergedTaskIds ?? [])
                .concat(grouped.map((task) => task.id)),
            ),
          ];
          const dueDates = [
            ...new Set(tasks.map((task) => task.dueDate).filter((date) => date !== null)),
          ];
          const typeIds = [
            ...new Set(tasks.map((task) => task.typeId).filter((type) => type != null)),
          ];
          const milestones = [...new Set(tasks.map((task) => task.milestone).filter(Boolean))];
          const acceptanceCriteria = [
            ...new Set(tasks.map((task) => task.acceptanceCriteria).filter(Boolean)),
          ].join("\n\n");
          if (
            sources.length > 50 ||
            mergedTaskIds.length > 200 ||
            acceptanceCriteria.length > 10000
          )
            return yield* new WorkTaskError({ reason: "conflict" });
          if (dueDates.length > 1 || typeIds.length > 1 || milestones.length > 1)
            return yield* new WorkTaskError({ reason: "conflict" });
          const principal = {
            ...seed,
            title: input.title,
            notes: input.notes,
            status: input.status,
            projectId: input.projectId,
            expectedVersion: input.expectedVersion,
            sources,
            mergedTaskIds,
            dueDate: dueDates[0] ?? null,
            typeId: typeIds[0] ?? null,
            milestone: milestones[0] ?? "",
            acceptanceCriteria,
            dependsOn: [...new Set(tasks.flatMap((task) => task.dependsOn ?? []))],
            externalDependsOn: [...new Set(tasks.flatMap((task) => task.externalDependsOn ?? []))],
          };
          const absorbed = grouped.map((task) => ({
            ...task,
            status: "merged" as const,
            notes: `Fusionnée dans : ${principal.title} — ID : ${principal.id}\n\n${task.notes}`,
            expectedVersion: task.version,
          }));
          if (absorbed.some((task) => task.notes.length > 20000))
            return yield* new WorkTaskError({ reason: "conflict" });
          const graph = all.map((task) =>
            task.id === seed.id
              ? principal
              : (absorbed.find((member) => member.id === task.id) ?? {
                  ...task,
                  expectedVersion: task.version,
                }),
          );
          const error = validateTaskDependencies(graph, yield* listChantiers());
          if (error) return yield* error;
          const saved = yield* saveInternal(principal, callerThreadId, graph);
          for (const member of absorbed) yield* saveInternal(member, undefined, graph);
          return saved;
        }),
      )
      .pipe(Effect.mapError((cause) => (isWorkTaskError(cause) ? cause : storageError())));
    yield* changed;
    return result;
  });
  const save = (input: WorkTaskSaveInput, callerThreadId?: ThreadId) =>
    input.qualificationGroup
      ? groupQualification(input, callerThreadId)
      : saveInternal(input, callerThreadId);

  const completeForSettledThread = Effect.fn("WorkTaskService.completeForSettledThread")(function* (
    threadId: ThreadId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql`UPDATE work_tasks
      SET version = version + 1,
        payload_json = json_set(payload_json, '$.status', CASE WHEN json_extract(payload_json, '$.chantierId') IS NULL THEN 'done' ELSE 'review' END, '$.version', version + 1, '$.updatedAt', ${now})
      WHERE json_extract(payload_json, '$.agentThreadId') = ${threadId}
        AND (json_extract(payload_json, '$.status') IN ('todo', 'ready', 'doing') OR (json_extract(payload_json, '$.status') = 'review' AND json_extract(payload_json, '$.chantierId') IS NULL))
      RETURNING id`.pipe(Effect.mapError(storageError));
    if (rows.length > 0) yield* changed;
  });

  const claim = Effect.fn("WorkTaskService.claim")(function* (
    threadId: ThreadId,
    input: WorkTaskClaimInput,
    release = false,
  ) {
    const task = yield* read(input.id);
    if (task.chantierId) yield* assertChantierAccess(threadId);
    const callers = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`.pipe(
      Effect.mapError(storageError),
    );
    const caller = callers[0];
    if (!caller) return yield* new WorkTaskError({ reason: "agent" });
    if (task.projectId !== null && task.projectId !== caller.project_id)
      return yield* new WorkTaskError({ reason: "project" });
    if (task.agentThreadId !== null && task.agentThreadId !== threadId)
      return yield* new WorkTaskError({ reason: "conflict" });
    if (release ? task.agentThreadId === null : task.agentThreadId === threadId) return task;
    if (task.version !== input.expectedVersion || (!release && isClosedWorkTaskStatus(task.status)))
      return yield* new WorkTaskError({ reason: "conflict" });
    if (!release) yield* assertCanStart(task);
    return yield* save(
      {
        ...task,
        projectId: task.projectId ?? ProjectId.make(caller.project_id),
        agentThreadId: release ? null : threadId,
        expectedVersion: input.expectedVersion,
      },
      threadId,
    );
  });
  const deleteTask = Effect.fn("WorkTaskService.delete")(function* (input: WorkTaskDeleteInput) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const dependents =
            yield* sql`SELECT work_tasks.id FROM work_tasks, json_each(json_extract(payload_json, '$.dependsOn')) dep WHERE dep.value = ${input.id} LIMIT 1`;
          if (dependents.length) return yield* new WorkTaskError({ reason: "referenced" });
          const rows =
            yield* sql`DELETE FROM work_tasks WHERE id = ${input.id} AND version = ${input.expectedVersion} RETURNING id`;
          if (!rows.length) return yield* new WorkTaskError({ reason: "conflict" });
        }),
      )
      .pipe(Effect.mapError((cause) => (isWorkTaskError(cause) ? cause : storageError())));
    yield* changed;
  });

  const ingestGmail = Effect.fn("WorkTaskService.ingestGmail")(function* (input: GmailTaskMessage) {
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const message = yield* validateGmailMessage(input);
          const existing = yield* sql<{
            payload_json: string | null;
          }>`SELECT payload_json FROM work_task_gmail_messages
        WHERE account_email = ${message.accountEmail} AND message_id = ${message.id}`;
          const sourceMessage = { ...message, text: message.text.slice(0, 6000) };
          if (existing[0]) {
            if (existing[0].payload_json === null) {
              yield* sql`UPDATE work_task_gmail_messages SET payload_json = ${yield* encodeGmailMessage(sourceMessage)}
              WHERE account_email = ${message.accountEmail} AND message_id = ${message.id} AND payload_json IS NULL`;
            }
            return "duplicate" as const;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const url = gmailMessageUrl(message.accountEmail, message.id);
          const task: WorkTask = {
            id: `gmail:${message.accountEmail}:${message.id}`,
            title: (message.subject.trim() || "Nouveau message Gmail").slice(0, 240),
            notes:
              `Gmail - ${message.sender}\nCompte : ${message.accountEmail}\n${url}\n\n${message.text}`.slice(
                0,
                20_000,
              ),
            sources: [
              {
                kind: "email",
                label: message.sender || "Email",
                url,
              },
            ],
            status: "unqualified",
            projectId: null,
            agentThreadId: null,
            dueDate: null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${task.id}, 1, ${yield* encode(task)})`;
          yield* sql`INSERT INTO work_task_gmail_messages (account_email, message_id, task_id, payload_json)
        VALUES (${message.accountEmail}, ${message.id}, ${task.id}, ${yield* encodeGmailMessage(sourceMessage)})`;
          return "created" as const;
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (result !== "duplicate") yield* changed;
    return result;
  });

  const ingestSlack = Effect.fn("WorkTaskService.ingestSlack")(function* (input: SlackTaskMessage) {
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const message = yield* validateMessage(input);
          const existing = yield* sql`SELECT task_id FROM work_task_slack_messages
        WHERE workspace_id = ${message.workspaceId} AND channel_id = ${message.channelId}
        AND message_ts = ${message.ts}`;
          if (existing.length > 0) return "duplicate" as const;
          const candidates = yield* sql<{ payload_json: string }>`SELECT task.payload_json
        FROM work_task_slack_messages AS source JOIN work_tasks AS task ON source.task_id = task.id
        WHERE source.workspace_id = ${message.workspaceId} AND source.channel_id = ${message.channelId}
          AND source.thread_ts = ${message.threadTs} AND json_extract(task.payload_json, '$.status') = 'unqualified'
        ORDER BY task.rowid DESC LIMIT 1`;
          const previous = candidates[0] ? yield* decode(candidates[0].payload_json) : null;
          const now = DateTime.formatIso(yield* DateTime.now);
          const next: WorkTask = previous
            ? {
                ...previous,
                version: previous.version + 1,
                updatedAt: now,
              }
            : {
                id: `slack:${message.workspaceId}:${message.channelId}:${message.ts}`,
                title:
                  `${message.channelName || "Slack"} — ${message.text.trim() || "Nouveau message"}`
                    .replace(/\s+/g, " ")
                    .slice(0, 240)
                    .trim(),
                notes: "",
                sources: [
                  {
                    kind: "slack",
                    label: message.channelName || "Slack",
                    url: `https://app.slack.com/archives/${message.channelId}/p${message.ts.replace(".", "")}`,
                  },
                ],
                status: "unqualified",
                projectId: null,
                agentThreadId: null,
                dueDate: null,
                version: 1,
                createdAt: now,
                updatedAt: now,
              };
          const payload = yield* encode(next);
          if (previous) {
            yield* sql`UPDATE work_tasks SET version = ${next.version}, payload_json = ${payload} WHERE id = ${next.id}`;
          } else {
            yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${next.id}, ${next.version}, ${payload})`;
          }
          yield* sql`INSERT INTO work_task_slack_messages (workspace_id, channel_id, message_ts, thread_ts, task_id, payload_json)
        VALUES (${message.workspaceId}, ${message.channelId}, ${message.ts}, ${message.threadTs}, ${next.id}, ${yield* encodeMessage(message)})`;
          return previous ? ("appended" as const) : ("created" as const);
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (result !== "duplicate") yield* changed;
    return result;
  });

  return WorkTaskService.of({
    listChantiers,
    readChantier,
    saveChantier,
    claimChantier,
    applyPlan,
    assertCanStart,
    subscribeChantiers: () =>
      SubscriptionRef.changes(revision).pipe(Stream.mapEffect(listChantiers)),
    read,
    completeForSettledThread,
    claim,
    types,
    saveTypes,
    subscribeTypes: () => SubscriptionRef.changes(revision).pipe(Stream.mapEffect(types)),
    list,
    messages,
    subscribeMessages: (id) =>
      SubscriptionRef.changes(revision).pipe(Stream.mapEffect(() => messages(id))),
    subscribe: () => SubscriptionRef.changes(revision).pipe(Stream.mapEffect(list)),
    save,
    reserveQualification,
    delete: deleteTask,
    ingestSlack,
    ingestGmail,
  });
});

export const layer = Layer.effect(WorkTaskService, make);
