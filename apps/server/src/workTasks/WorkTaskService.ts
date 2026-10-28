import {
  WorkTask,
  WorkTaskError,
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
    readonly list: () => Effect.Effect<ReadonlyArray<WorkTask>, WorkTaskError>;
    readonly subscribe: () => Stream.Stream<ReadonlyArray<WorkTask>, WorkTaskError>;
    readonly save: (input: WorkTaskSaveInput) => Effect.Effect<WorkTask, WorkTaskError>;
    readonly delete: (input: WorkTaskDeleteInput) => Effect.Effect<void, WorkTaskError>;
  }
>()("t3/workTasks/WorkTaskService") {}

const isWorkTaskError = Schema.is(WorkTaskError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const revision = yield* SubscriptionRef.make(0);
  const codec = Schema.fromJsonString(WorkTask);
  const decode = Schema.decodeUnknownEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const storageError = () => new WorkTaskError({ reason: "storage" });
  const changed = SubscriptionRef.update(revision, (value) => value + 1);

  const list = Effect.fn("WorkTaskService.list")(function* () {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_tasks ORDER BY rowid DESC`.pipe(Effect.mapError(storageError));
    return yield* Effect.forEach(rows, (row) =>
      decode(row.payload_json).pipe(Effect.mapError(storageError)),
    );
  });

  const save = Effect.fn("WorkTaskService.save")(function* (input: WorkTaskSaveInput) {
    const task = yield* sql
      .withTransaction(
        Effect.gen(function* () {
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
            title: input.title,
            notes: input.notes,
            status: input.status,
            projectId: input.projectId,
            agentThreadId: input.agentThreadId,
            dueDate: input.dueDate,
            version: input.expectedVersion + 1,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
          };
          yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${next.id}, ${next.version}, ${yield* encode(next)})
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload_json = excluded.payload_json`;
          return next;
        }),
      )
      .pipe(Effect.catch((cause) => Effect.fail(isWorkTaskError(cause) ? cause : storageError())));
    yield* changed;
    return task;
  });

  const deleteTask = Effect.fn("WorkTaskService.delete")(function* (input: WorkTaskDeleteInput) {
    const rows =
      yield* sql`DELETE FROM work_tasks WHERE id = ${input.id} AND version = ${input.expectedVersion} RETURNING id`.pipe(
        Effect.mapError(storageError),
      );
    if (rows.length === 0) return yield* new WorkTaskError({ reason: "conflict" });
    yield* changed;
  });

  return WorkTaskService.of({
    list,
    subscribe: () => SubscriptionRef.changes(revision).pipe(Stream.mapEffect(list)),
    save,
    delete: deleteTask,
  });
});

export const layer = Layer.effect(WorkTaskService, make);
