import { validateTaskDependencies } from "./taskDependencies.ts";
import { GmailTaskMessage } from "./gmailTaskRules.ts";
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
    readonly assertCanStart: (task: WorkTask) => Effect.Effect<void, WorkTaskError>;
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const revision = yield* SubscriptionRef.make(0);
  const codec = Schema.fromJsonString(WorkTask);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const messageCodec = Schema.fromJsonString(SlackTaskMessage);
  const decodeMessage = Schema.decodeUnknownEffect(messageCodec);
  const encodeMessage = Schema.encodeEffect(messageCodec);
  const storageError = () => new WorkTaskError({ reason: "storage" });
  const changed = SubscriptionRef.update(revision, (value) => value + 1);

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
      WHERE task_id = ${id} AND EXISTS (SELECT 1 FROM work_tasks WHERE id = ${id})
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
  const saveChantier = (input: WorkChantierSaveInput) => saveChantierInternal(input);
  const claimChantier = Effect.fn("WorkTaskService.claimChantier")(function* (
    threadId: ThreadId,
    input: typeof WorkChantierClaimInput.Type,
    release = false,
  ) {
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
  const assertCanStart = Effect.fn("WorkTaskService.assertCanStart")(function* (task: WorkTask) {
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
          if (callerThreadId && (input.status === "todo" || input.status === "ready")) {
            const runs = yield* sql<{ task_id: string | null }>`SELECT r.task_id
              FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id = r.agent_id
              WHERE r.thread_id = ${callerThreadId}
                AND json_extract(a.payload_json, '$.trigger') = 'unqualified'`;
            if (runs[0]) {
              if (input.status === "ready")
                return yield* new WorkTaskError({ reason: "preparation" });
              const requests = yield* sql<{ approved: number }>`SELECT
                  (json_extract(payload_json, '$.kind') = 'approval'
                    AND json_extract(payload_json, '$.status') = 'accepted'
                    AND json_extract(payload_json, '$.qualification.decision') = 'keep') AS approved
                FROM agent_requests
                WHERE json_extract(payload_json, '$.threadId') = ${callerThreadId}
                  AND json_extract(payload_json, '$.qualification.decision') IS NOT NULL
                ORDER BY rowid DESC LIMIT 1`;
              if (runs[0].task_id !== input.id || requests[0]?.approved !== 1)
                return yield* new WorkTaskError({ reason: "approval" });
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
            (previous?.status !== next.status || previous.agentThreadId !== next.agentThreadId)
          ) {
            const chantier = next.chantierId ? yield* readChantier(next.chantierId) : null;
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
  const save = (input: WorkTaskSaveInput, callerThreadId?: ThreadId) =>
    saveInternal(input, callerThreadId);

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
    return yield* save({
      ...task,
      projectId: task.projectId ?? ProjectId.make(caller.project_id),
      agentThreadId: release ? null : threadId,
      expectedVersion: input.expectedVersion,
    });
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
          const existing = yield* sql`SELECT task_id FROM work_task_gmail_messages
        WHERE account_email = ${message.accountEmail} AND message_id = ${message.id}`;
          if (existing.length > 0) return "duplicate" as const;
          const now = DateTime.formatIso(yield* DateTime.now);
          const task: WorkTask = {
            id: `gmail:${message.accountEmail}:${message.id}`,
            title: (message.subject.trim() || "Nouveau message Gmail").slice(0, 240),
            notes:
              `Gmail - ${message.sender}\nCompte : ${message.accountEmail}\nhttps://mail.google.com/mail/u/?authuser=${encodeURIComponent(message.accountEmail)}#all/${message.id}\n\n${message.text}`.slice(
                0,
                20_000,
              ),
            sources: [
              {
                kind: "email",
                label: message.sender || "Email",
                url: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(message.accountEmail)}#all/${message.id}`,
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
          yield* sql`INSERT INTO work_task_gmail_messages (account_email, message_id, task_id)
        VALUES (${message.accountEmail}, ${message.id}, ${task.id})`;
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
    delete: deleteTask,
    ingestSlack,
    ingestGmail,
  });
});

export const layer = Layer.effect(WorkTaskService, make);
