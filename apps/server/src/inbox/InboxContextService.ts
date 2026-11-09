import {
  InboxContext,
  InboxContextResult,
  InboxContextBackfillInput,
  InboxContextBackfillResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Inbox from "./MessageInbox.ts";
import * as Source from "./InboxContextSource.ts";
import { selectContext } from "./contextMessages.ts";

export class InboxContextError extends Schema.TaggedError<InboxContextError>()(
  "InboxContextError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Impossible d’enrichir l’inbox.";
  }
}
const State = Schema.Struct({
  id: Schema.String,
  through: Schema.Int,
  targets: Schema.Int,
  after: Schema.Int,
  reviewed: Schema.Int,
});
const decodeState = Schema.decodeEffect(Schema.fromJsonString(State));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const validateInput = Schema.decodeEffect(InboxContextBackfillInput);
export class InboxContextService extends Context.Service<
  InboxContextService,
  {
    readonly enrich: (
      id: string,
      batchId?: string,
    ) => Effect.Effect<InboxContext, InboxContextError>;
    readonly backfill: (
      input: typeof InboxContextBackfillInput.Type,
    ) => Effect.Effect<typeof InboxContextBackfillResult.Type, InboxContextError>;
  }
>()("t3/inbox/InboxContextService") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* Inbox.MessageInbox;
  const source = yield* Source.InboxContextSource;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const entryLock = yield* Semaphore.make(1);
  const batchLock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, "inbox-context-backfill.json");
  const enrich = Effect.fn("InboxContextService.enrich")(
    function* (id: string, batchId?: string, retryUnavailable = false) {
      const entry = yield* inbox.read({ id });
      if (
        entry.context?.version === 1 &&
        !(retryUnavailable && entry.context.status === "unavailable")
      )
        return entry.context;
      const result: InboxContextResult = yield* source.read(entry.source).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => {
              if (result.status === "unavailable") return { ...result, messages: [] };
              const selected = selectContext(
                entry.source,
                result.messages,
                result.status === "partial",
              );
              return {
                ...selected,
                truncated: selected.truncated || result.truncated,
                reason: result.reason,
              };
            },
            catch: (cause) => new Source.InboxContextSourceError({ reason: "format", cause }),
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            status: "unavailable" as const,
            messages: [],
            truncated: false,
            reason: error.reason,
          }),
        ),
      );
      const context: InboxContext = {
        ...result,
        version: 1,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        ...(batchId ? { batchId } : {}),
      };
      yield* inbox.setContext(id, context);
      return context;
    },
    entryLock.withPermits(1),
    Effect.mapError((cause) => new InboxContextError({ cause })),
  );
  const backfill = Effect.fn("InboxContextService.backfill")(
    function* (input: typeof InboxContextBackfillInput.Type) {
      const { limit = 3, retryUnavailableIds } = yield* validateInput(input);
      const raw = yield* fs.readFileString(statePath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      let state =
        raw === null
          ? yield* sql.withTransaction(
              Effect.gen(function* () {
                const [row] = yield* sql<{
                  through: number;
                  targets: number;
                }>`SELECT COALESCE(MAX(sequence),0) AS through, COUNT(*) AS targets FROM message_inbox`;
                return {
                  id: DateTime.formatIso(yield* DateTime.now),
                  through: row!.through,
                  targets: row!.targets,
                  after: 0,
                  reviewed: 0,
                };
              }),
            )
          : yield* decodeState(raw);
      const save = Effect.gen(function* () {
        yield* fs.writeFileString(statePath + ".next", yield* encodeState(state));
        yield* fs.rename(statePath + ".next", statePath);
      });
      // Persist the scope before the first connector call: new arrivals belong to a later pass.
      if (raw === null) yield* save;
      if (retryUnavailableIds) {
        if (state.reviewed !== state.targets)
          return yield* new InboxContextError({
            cause: "Finish the initial inbox snapshot before retrying.",
          });
        for (const id of new Set(retryUnavailableIds)) {
          const [row] = yield* sql<{ id: string }>`SELECT id FROM message_inbox
            WHERE id=${id} AND sequence<=${state.through}
            AND json_extract(payload_json,'$.context.status')='unavailable'`;
          if (row) yield* enrich(row.id, state.id, true);
        }
      }
      const rows = yield* sql<{
        sequence: number;
        id: string;
      }>`SELECT sequence,id FROM message_inbox
      WHERE sequence > ${state.after} AND sequence <= ${state.through} ORDER BY sequence LIMIT ${limit}`;
      for (const row of rows) {
        yield* enrich(row.id, state.id);
        state = {
          id: state.id,
          through: state.through,
          targets: state.targets,
          after: row.sequence,
          reviewed: state.reviewed + 1,
        };
        yield* save;
      }
      const [counts] = yield* sql<{
        updated: number;
        with_context: number;
        empty: number;
        failed: number;
        partial: number;
      }>`SELECT
      COUNT(*) AS updated,
      COALESCE(SUM(json_array_length(payload_json,'$.context.messages') > 0),0) AS with_context,
      COALESCE(SUM(json_extract(payload_json,'$.context.status') = 'ready' AND json_array_length(payload_json,'$.context.messages') = 0),0) AS empty,
      COALESCE(SUM(json_extract(payload_json,'$.context.status') = 'unavailable' OR (json_extract(payload_json,'$.context.status') = 'partial' AND json_array_length(payload_json,'$.context.messages') = 0)),0) AS failed,
      COALESCE(SUM(json_extract(payload_json,'$.context.status') = 'partial'),0) AS partial
      FROM message_inbox WHERE sequence <= ${state.after} AND sequence <= ${state.through}
      AND json_extract(payload_json,'$.context.batchId') = ${state.id}`;
      return {
        batchId: state.id,
        targets: state.targets,
        reviewed: state.reviewed,
        updated: counts!.updated,
        alreadyProcessed: state.reviewed - counts!.updated,
        withContext: counts!.with_context,
        empty: counts!.empty,
        failed: counts!.failed,
        partial: counts!.partial,
        remaining: state.targets - state.reviewed,
      };
    },
    batchLock.withPermits(1),
    Effect.mapError((cause) => new InboxContextError({ cause })),
  );
  return InboxContextService.of({ enrich, backfill });
});
export const layer = Layer.effect(InboxContextService, make);
