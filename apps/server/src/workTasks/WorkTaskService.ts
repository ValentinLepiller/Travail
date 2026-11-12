import {
  initialChantierV2,
  taskDefinition,
  decideChantierV2,
  defaultChantierPolicy,
} from "./chantierV2Policy.ts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import {
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import { validateTaskDependencies } from "./taskDependencies.ts";
import { GmailTaskMessage } from "./gmailTaskRules.ts";
import {
  ChantierProjectPolicy,
  type ChantierV2Command,
  WorkTask,
  ChatImageAttachment,
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
  isChefDossierThread,
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
    readonly assertChantierMerge: (input: {
      projectId: ProjectId;
      url: string;
      head: string;
      stack: boolean;
      auto: boolean;
    }) => Effect.Effect<boolean, WorkTaskError>;
    readonly chantierPolicy: (
      projectId: ProjectId,
    ) => Effect.Effect<ChantierProjectPolicy, WorkTaskError>;
    readonly saveChantierPolicy: (
      input: ChantierProjectPolicy,
    ) => Effect.Effect<ChantierProjectPolicy, WorkTaskError>;
    readonly commandChantierV2: (
      input: ChantierV2Command,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
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
const isWorkTaskStatus = Schema.is(WorkTask.fields.status);
const decodeImages = Schema.decodeUnknownEffect(Schema.Array(ChatImageAttachment));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const imageStorage = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(ServerConfig.ServerConfig, config),
  );
  const revision = yield* SubscriptionRef.make(0);
  const codec = Schema.fromJsonString(WorkTask);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const messageCodec = Schema.fromJsonString(SlackTaskMessage);
  const decodeMessage = Schema.decodeUnknownEffect(messageCodec);
  const storageError = () => new WorkTaskError({ reason: "storage" });
  const changed = SubscriptionRef.update(revision, (value) => value + 1);

  const assertChantierAccess = Effect.fn(function* (
    callerThreadId?: ThreadId,
    chantierId?: string | null,
  ) {
    if (!callerThreadId) return;
    const runs = yield* sql`SELECT r.thread_id FROM autonomous_agent_runs r
      JOIN autonomous_agents a ON a.id = r.agent_id
      WHERE r.thread_id = ${callerThreadId}
        AND (json_extract(a.payload_json, '$.trigger') IN ('unqualified', 'todo') OR json_extract(a.payload_json, '$.kind') = 'chef' OR (json_extract(a.payload_json, '$.kind') = 'chantier-chef' AND (${chantierId ?? null} IS NULL OR json_extract(a.payload_json, '$.chantierId') != ${chantierId ?? null} OR json_extract(a.payload_json, '$.currentThreadId') != ${callerThreadId}))) LIMIT 1`.pipe(
      Effect.mapError(storageError),
    );
    if (runs.length) return yield* new WorkTaskError({ reason: "chantierScope" });
  });

  const assertV2Caller = Effect.fn(function* (chantier: WorkChantier, callerThreadId?: ThreadId) {
    if (!callerThreadId || chantier.generation !== "v2") return;
    const rows = yield* sql`SELECT r.thread_id FROM autonomous_agent_runs r
      JOIN autonomous_agents a ON a.id=r.agent_id
      WHERE r.thread_id=${callerThreadId} AND a.id=${chantier.v2!.chefAgentId}
      AND json_extract(a.payload_json,'$.kind')='chantier-chef'
      AND json_extract(a.payload_json,'$.currentThreadId')=${callerThreadId}`.pipe(
      Effect.mapError(storageError),
    );
    if (!rows.length) return yield* new WorkTaskError({ reason: "chantierScope" });
  });
  const policyCodec = Schema.fromJsonString(ChantierProjectPolicy);
  const chantierPolicy = Effect.fn(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_chantier_project_policies WHERE project_id=${projectId}`.pipe(
      Effect.mapError(storageError),
    );
    return rows[0]
      ? yield* Schema.decodeUnknownEffect(policyCodec)(rows[0].payload_json).pipe(
          Effect.mapError(storageError),
        )
      : defaultChantierPolicy(projectId);
  });
  const saveChantierPolicy = Effect.fn(function* (input: ChantierProjectPolicy) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const project =
            yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${input.projectId} AND deleted_at IS NULL`;
          if (!project.length) return yield* new WorkTaskError({ reason: "project" });
          const old = yield* chantierPolicy(input.projectId);
          if (old.expectedVersion !== input.expectedVersion)
            return yield* new WorkTaskError({ reason: "conflict" });
          const next = { ...input, expectedVersion: input.expectedVersion + 1 };
          const payload = yield* Schema.encodeEffect(policyCodec)(next);
          yield* sql`INSERT INTO work_chantier_project_policies(project_id,version,payload_json) VALUES(${input.projectId},${next.expectedVersion},${payload}) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,payload_json=excluded.payload_json`;
          yield* changed;
          return next;
        }),
      )
      .pipe(Effect.mapError((e) => (isWorkTaskError(e) ? e : storageError())));
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
  const reserveQualification = () => Effect.fail(new WorkTaskError({ reason: "status" }));
  const listChantiers = Effect.fn("WorkTaskService.listChantiers")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_chantiers ORDER BY rowid DESC`;
    return yield* Effect.forEach(rows, (row) =>
      decodeChantier(row.payload_json).pipe(
        Effect.map((c) => ({ ...c, generation: c.generation ?? ("legacy" as const) })),
      ),
    );
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
          if (
            previous &&
            input.generation !== undefined &&
            input.generation !== (previous.generation ?? "legacy")
          )
            return yield* new WorkTaskError({ reason: "generation" });
          if (
            previous?.generation === "v2" &&
            (input.status !== previous.status || input.projectId !== previous.projectId)
          )
            return yield* new WorkTaskError({ reason: "approval" });
          if (!previous && input.generation === "v2" && input.status !== "draft")
            return yield* new WorkTaskError({ reason: "approval" });
          const now = DateTime.formatIso(yield* DateTime.now);
          const { expectedVersion, ...fields } = input;
          const chantier: WorkChantier = {
            ...fields,
            ...(previous?.generation ? { generation: previous.generation } : {}),
            ...((previous?.generation ?? input.generation) === "v2"
              ? {
                  v2: {
                    ...(previous?.v2 ?? initialChantierV2(input.id)),
                    framingApproved:
                      !!previous?.v2?.framingApproved &&
                      previous.objective === input.objective &&
                      previous.scope === input.scope &&
                      previous.decisions === input.decisions,
                  },
                }
              : {}),
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
    yield* assertChantierAccess(callerThreadId, input.id);
    if (input.expectedVersion) yield* assertV2Caller(yield* readChantier(input.id), callerThreadId);
    else if (callerThreadId && input.generation === "v2")
      return yield* new WorkTaskError({ reason: "approval" });
    return yield* saveChantierInternal(input);
  });
  const claimChantier = Effect.fn("WorkTaskService.claimChantier")(function* (
    threadId: ThreadId,
    input: typeof WorkChantierClaimInput.Type,
    release = false,
  ) {
    yield* assertChantierAccess(threadId, input.id);
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const chantier = yield* readChantier(input.id);
          if (chantier.generation === "v2")
            return yield* new WorkTaskError({ reason: "generation" });
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
  const assertV2Start = Effect.fn(function* (task: WorkTask, chantier: WorkChantier) {
    const v2 = chantier.v2!;
    const review = v2.reviews.find((r) => r.taskId === task.id);
    if (
      !v2.framingApproved ||
      v2.stopped ||
      chantier.status !== "active" ||
      review?.approvedDefinition !== taskDefinition(task)
    )
      return yield* new WorkTaskError({ reason: "approval" });
    const policy = yield* chantierPolicy(chantier.projectId);
    const active = yield* sql<{ count: number }>`SELECT count(*) AS count FROM work_tasks t
      WHERE t.id != ${task.id} AND json_extract(t.payload_json,'$.projectId')=${chantier.projectId}
      AND (json_extract(t.payload_json,'$.status')='doing' OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id=json_extract(t.payload_json,'$.agentThreadId') AND r.status IN ('preparing','queued','starting','running','waiting')
      ))`.pipe(Effect.mapError(storageError));
    if (active[0]!.count >= policy.maxParallel)
      return yield* new WorkTaskError({ reason: "parallelism" });
  });
  const assertCanStart = Effect.fn("WorkTaskService.assertCanStart")(function* (
    task: WorkTask,
    callerThreadId?: ThreadId,
  ) {
    yield* assertChefScope(task.projectId, callerThreadId);
    if (task.chantierId) yield* assertChantierAccess(callerThreadId, task.chantierId);
    if (!task.chantierId && !task.dependsOn?.length && !task.externalDependsOn?.length) return;
    const chantier = task.chantierId ? yield* readChantier(task.chantierId) : null;
    if (chantier?.generation === "v2") {
      yield* assertV2Caller(chantier, callerThreadId);
      yield* assertV2Start(task, chantier);
    }
    if (chantier && chantier.status !== "active")
      return yield* new WorkTaskError({ reason: "preparation" });
    if (workTaskBlockers(task, yield* list(), chantier?.externalDependencies).length)
      return yield* new WorkTaskError({ reason: "dependencies" });
  });
  const applyPlan = Effect.fn("WorkTaskService.applyPlan")(function* (
    input: WorkChantierPlanInput,
    callerThreadId?: ThreadId,
  ) {
    yield* assertChantierAccess(callerThreadId, input.chantier.id);
    if (input.chantier.expectedVersion) {
      const c = yield* readChantier(input.chantier.id);
      yield* assertV2Caller(c, callerThreadId);
      if (c.generation === "v2" && !c.v2?.framingApproved && input.tasks.length)
        return yield* new WorkTaskError({ reason: "approval" });
    } else if (input.chantier.generation === "v2" && input.tasks.length)
      return yield* new WorkTaskError({ reason: "approval" });
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

  const assertChantierMerge = Effect.fn(function* (input: {
    projectId: ProjectId;
    url: string;
    head: string;
    stack: boolean;
    auto: boolean;
  }) {
    const chantiers = (yield* listChantiers()).filter(
      (c) => c.generation === "v2" && c.projectId === input.projectId,
    );
    if (input.stack && chantiers.length) return yield* new WorkTaskError({ reason: "approval" });
    let managed = false;
    for (const c of chantiers)
      for (const review of c.v2!.reviews.filter((r) => r.pullRequestUrl === input.url)) {
        managed = true;
        const task = yield* read(review.taskId);
        if (
          input.auto ||
          c.status !== "active" ||
          c.v2!.stopped ||
          !c.v2!.framingApproved ||
          review.head !== input.head ||
          review.humanHead !== input.head ||
          review.chefHead !== input.head ||
          review.approvedDefinition !== taskDefinition(task)
        )
          return yield* new WorkTaskError({ reason: "approval" });
      }
    return managed;
  });
  const commandChantierV2 = Effect.fn(function* (
    input: ChantierV2Command,
    callerThreadId?: ThreadId,
  ) {
    const next = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* readChantier(input.id);
          yield* assertV2Caller(current, callerThreadId);
          const decided = decideChantierV2(
            current,
            input,
            (yield* list()).filter((t) => t.chantierId === current.id),
            callerThreadId ? "chef" : "human",
            yield* chantierPolicy(current.projectId),
          );
          if (isWorkTaskError(decided)) return yield* decided;
          const now = DateTime.formatIso(yield* DateTime.now);
          const chantier = { ...decided.chantier, version: current.version + 1, updatedAt: now };
          yield* sql`UPDATE work_chantiers SET version=${chantier.version},payload_json=${yield* encodeChantier(chantier)} WHERE id=${current.id}`;
          if (decided.task) {
            const task = { ...decided.task, version: decided.task.version + 1, updatedAt: now };
            yield* sql`UPDATE work_tasks SET version=${task.version},payload_json=${yield* encode(task)} WHERE id=${task.id}`;
            yield* closeInboxSubjects([task.id], now);
          }
          return chantier;
        }),
      )
      .pipe(Effect.mapError(domainError));
    yield* changed;
    return next;
  });

  const closeInboxSubjects = (ids: ReadonlyArray<string>, at: string) => sql`UPDATE inbox_subjects
    SET closed_at=${at},action_version=action_version+1
    WHERE closed_at IS NULL AND task_id IN (
      SELECT id FROM work_tasks WHERE ${sql.in("id", ids)} AND json_extract(payload_json,'$.status')='done'
    )`;
  const saveInternal = Effect.fn("WorkTaskService.save")(function* (
    input: WorkTaskSaveInput,
    callerThreadId?: ThreadId,
    plannedTasks?: ReadonlyArray<WorkTaskSaveInput>,
  ) {
    if (!isWorkTaskStatus(input.status)) return yield* new WorkTaskError({ reason: "status" });
    const claimedPaths: string[] = [];
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
            if (isChefDossierThread(input.agentThreadId))
              return yield* new WorkTaskError({ reason: "agent" });
            const agents = yield* sql`SELECT project_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${input.agentThreadId} AND deleted_at IS NULL
          AND (${input.projectId} IS NULL OR project_id = ${input.projectId})`;
            if (agents.length === 0) return yield* new WorkTaskError({ reason: "agent" });
          }
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM work_tasks WHERE id = ${input.id}`;
          const previous = rows[0] ? yield* decode(rows[0].payload_json) : null;
          if (callerThreadId && !previous?.chantierId && !input.chantierId) {
            const chefs =
              yield* sql`SELECT r.thread_id FROM autonomous_agent_runs r JOIN autonomous_agents a ON a.id=r.agent_id WHERE r.thread_id=${callerThreadId} AND json_extract(a.payload_json,'$.kind')='chantier-chef'`;
            if (chefs.length) return yield* new WorkTaskError({ reason: "chantierScope" });
          }
          yield* assertChefScope(input.projectId, callerThreadId);
          if (previous) yield* assertChefScope(previous.projectId, callerThreadId);
          if (previous?.chantierId || input.chantierId)
            yield* assertChantierAccess(
              callerThreadId,
              input.chantierId === undefined ? previous?.chantierId : input.chantierId,
            );
          if (
            (previous?.version ?? 0) !== input.expectedVersion ||
            (!previous && input.expectedVersion !== 0)
          ) {
            return yield* new WorkTaskError({ reason: "conflict" });
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const automationMode = input.automationMode ?? previous?.automationMode;
          const inboxSubjectIds = input.inboxSubjectIds ?? previous?.inboxSubjectIds;
          const next: WorkTask = {
            id: input.id,
            ...(automationMode ? { automationMode } : {}),
            ...(inboxSubjectIds ? { inboxSubjectIds } : {}),
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
            attachments: input.attachments ?? previous?.attachments ?? [],
            status: input.status,
            projectId: input.projectId,
            agentThreadId: input.agentThreadId,
            dueDate: input.dueDate,
            version: input.expectedVersion + 1,
            qualifiedAt: previous?.qualifiedAt ?? null,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };
          const chantiers = yield* listChantiers();
          const oldChantier = chantiers.find((c) => c.id === previous?.chantierId);
          const newChantier = chantiers.find((c) => c.id === next.chantierId);
          if (oldChantier?.generation === "v2") {
            if (previous?.agentThreadId !== callerThreadId)
              yield* assertV2Caller(oldChantier, callerThreadId);
            if (next.chantierId !== previous?.chantierId || next.projectId !== previous?.projectId)
              return yield* new WorkTaskError({ reason: "generation" });
          }
          if (newChantier?.generation === "v2") {
            if (previous?.agentThreadId !== callerThreadId)
              yield* assertV2Caller(newChantier, callerThreadId);
            if (
              previous?.status === "doing" &&
              next.status === "doing" &&
              taskDefinition(previous) !== taskDefinition(next)
            )
              return yield* new WorkTaskError({ reason: "approval" });
            if (!newChantier.v2?.framingApproved)
              return yield* new WorkTaskError({ reason: "approval" });
            if (next.status === "merged" || next.status === "done") {
              const review = newChantier.v2.reviews.find((r) => r.taskId === next.id);
              if (next.status !== previous?.status || !review?.completionEvidence)
                return yield* new WorkTaskError({ reason: "approval" });
            }
            if (next.status === "doing" && previous?.status !== "doing")
              yield* assertV2Start(next, newChantier);
          }
          const all =
            plannedTasks ??
            (yield* list())
              .filter((item) => item.id !== next.id)
              .map((item) => ({ ...item, expectedVersion: item.version }))
              .concat({ ...next, expectedVersion: next.version });
          if (!plannedTasks) {
            const error = validateTaskDependencies(all, chantiers);
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
          let saved = next;
          if (input.attachments?.length) {
            const claimed = yield* claimPendingAttachments({
              threadId: `work-task-${input.id}`,
              attachments: input.attachments,
            }).pipe(
              Effect.provide(imageStorage),
              Effect.tap((claimed) =>
                Effect.sync(() => claimedPaths.push(...claimed.claimedPaths)),
              ),
              Effect.uninterruptible,
            );
            saved = {
              ...next,
              attachments: yield* decodeImages(claimed.attachments),
            };
          }
          yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${next.id}, ${next.version}, ${yield* encode(saved)})
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload_json = excluded.payload_json`;
          if (next.status === "done") yield* closeInboxSubjects([next.id], now);
          return saved;
        }),
      )
      .pipe(
        Effect.onError(() =>
          releaseClaimedAttachments(claimedPaths).pipe(Effect.provide(imageStorage)),
        ),
        Effect.mapError((cause) => (isWorkTaskError(cause) ? cause : storageError())),
      );
    if (!plannedTasks) yield* changed;
    return task;
  });
  const save = (input: WorkTaskSaveInput, callerThreadId?: ThreadId) =>
    input.qualificationGroup
      ? Effect.fail(new WorkTaskError({ reason: "status" }))
      : saveInternal(input, callerThreadId);

  const completeForSettledThread = Effect.fn("WorkTaskService.completeForSettledThread")(function* (
    threadId: ThreadId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`UPDATE work_tasks
      SET version = version + 1,
        payload_json = json_set(payload_json, '$.status', CASE WHEN json_extract(payload_json, '$.chantierId') IS NULL THEN 'done' ELSE 'review' END, '$.version', version + 1, '$.updatedAt', ${now})
      WHERE json_extract(payload_json, '$.agentThreadId') = ${threadId}
        AND (json_extract(payload_json, '$.status') IN ('todo', 'ready', 'doing') OR (json_extract(payload_json, '$.status') = 'review' AND json_extract(payload_json, '$.chantierId') IS NULL))
      RETURNING id`;
          if (rows.length)
            yield* closeInboxSubjects(
              rows.map((row) => row.id),
              now,
            );
          return rows;
        }),
      )
      .pipe(Effect.mapError(storageError));
    if (rows.length > 0) yield* changed;
  });

  const claim = Effect.fn("WorkTaskService.claim")(function* (
    threadId: ThreadId,
    input: WorkTaskClaimInput,
    release = false,
  ) {
    const task = yield* read(input.id);
    if (task.chantierId) yield* assertChantierAccess(threadId, task.chantierId);
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
          const task = yield* read(input.id);
          if (task.chantierId && (yield* readChantier(task.chantierId)).generation === "v2")
            return yield* new WorkTaskError({ reason: "referenced" });
          const dependents =
            yield* sql`SELECT work_tasks.id FROM work_tasks, json_each(json_extract(payload_json, '$.dependsOn')) dep WHERE dep.value = ${input.id} LIMIT 1`;
          if (dependents.length) return yield* new WorkTaskError({ reason: "referenced" });
          const rows =
            yield* sql`DELETE FROM work_tasks WHERE id = ${input.id} AND version = ${input.expectedVersion} RETURNING id`;
          if (!rows.length) return yield* new WorkTaskError({ reason: "conflict" });
          yield* sql`UPDATE inbox_subjects SET task_id=NULL,action_version=action_version+1 WHERE task_id=${input.id}`;
        }),
      )
      .pipe(Effect.mapError((cause) => (isWorkTaskError(cause) ? cause : storageError())));
    yield* changed;
  });

  // Retain a failure for callers from older integrations; collection now belongs to MessageInbox.
  const ingestGmail = () => Effect.fail(new WorkTaskError({ reason: "status" }));
  const ingestSlack = () => Effect.fail(new WorkTaskError({ reason: "status" }));

  return WorkTaskService.of({
    assertChantierMerge,
    chantierPolicy,
    saveChantierPolicy,
    commandChantierV2,
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
