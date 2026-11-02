import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as WorkTasks from "./WorkTaskService.ts";
import * as Source from "./SlackTaskSource.ts";
import { SlackTaskRules, acceptsSlackMessage } from "./slackTaskRules.ts";

const decodeRules = Schema.decodeEffect(Schema.fromJsonString(SlackTaskRules));

export const SlackTaskSyncResult = Schema.Struct({
  enabled: Schema.Boolean,
  created: Schema.Number,
  appended: Schema.Number,
  duplicate: Schema.Number,
  ignored: Schema.Number,
  pending: Schema.Boolean,
});
export const SlackTaskCollectionStatus = Schema.Struct({
  rulesPath: Schema.String,
  configured: Schema.Boolean,
  excludeChannelNames: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  workspaceId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(Schema.String),
  pending: Schema.Boolean,
});

export class SlackTaskCollector extends Context.Service<
  SlackTaskCollector,
  {
    readonly sync: () => Effect.Effect<
      typeof SlackTaskSyncResult.Type,
      Source.SlackCollectionError
    >;
    readonly status: () => Effect.Effect<
      typeof SlackTaskCollectionStatus.Type,
      Source.SlackCollectionError
    >;
  }
>()("t3/workTasks/SlackTaskCollector") {}

interface CollectionState {
  started_at: string;
  checkpoint: string;
  window_end: string | null;
  cursor: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const tasks = yield* WorkTasks.WorkTaskService;
  const source = yield* Source.SlackTaskSource;
  const lock = yield* Semaphore.make(1);
  const rulesPath = path.join(config.stateDir, "slack-task-rules.json");
  const readRules = Effect.fn("SlackTaskCollector.readRules")(
    function* () {
      const raw = yield* fs.readFileString(rulesPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      return raw === null ? null : yield* decodeRules(raw);
    },
    Effect.mapError((cause) => new Source.SlackCollectionError({ stage: "configuration", cause })),
  );
  const readState = (workspaceId: string) =>
    sql<CollectionState>`SELECT started_at, checkpoint, window_end, cursor
    FROM slack_task_collection WHERE workspace_id = ${workspaceId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError((cause) => new Source.SlackCollectionError({ stage: "storage", cause })),
    );
  const status = Effect.fn("SlackTaskCollector.status")(function* () {
    const rules = yield* readRules();
    const state = rules ? yield* readState(rules.workspaceId) : undefined;
    return {
      rulesPath,
      configured: rules !== null,
      excludeChannelNames: rules?.excludeChannelNames ?? [],
      enabled: rules?.enabled ?? false,
      workspaceId: rules?.workspaceId ?? null,
      startedAt: state?.started_at ?? null,
      checkpoint: state?.checkpoint ?? null,
      pending: state?.window_end != null,
    };
  });
  const sync = Effect.fn("SlackTaskCollector.sync")(function* () {
    const rules = yield* readRules();
    const result = {
      enabled: rules?.enabled ?? false,
      created: 0,
      appended: 0,
      duplicate: 0,
      ignored: 0,
      pending: false,
    };
    if (!rules?.enabled) return result;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const initial = `${now}.000000`;
    yield* sql`INSERT INTO slack_task_collection (workspace_id, started_at, checkpoint)
      VALUES (${rules.workspaceId}, ${initial}, ${initial}) ON CONFLICT(workspace_id) DO NOTHING`.pipe(
      Effect.mapError((cause) => new Source.SlackCollectionError({ stage: "storage", cause })),
    );
    const state = (yield* readState(rules.workspaceId))!;
    // Leave indexing time and replay an overlap; task message identities deduplicate replays.
    const before = state.window_end ?? Math.max(now - 30, Number(state.checkpoint)).toFixed(6);
    if (Number(before) <= Number(state.started_at)) return result;
    const after = Math.max(Number(state.started_at), Number(state.checkpoint) - 300).toFixed(6);
    let cursor = state.cursor;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = yield* source.readPage(rules.collector, {
        workspaceId: rules.workspaceId,
        after,
        before,
        cursor,
        ...(rules.collector.linkId ? { linkId: rules.collector.linkId } : {}),
      });
      if (page.nextCursor !== null && (page.nextCursor === cursor || page.messages.length === 0)) {
        return yield* new Source.SlackCollectionError({
          stage: "source",
          cause: "Pagination did not advance",
        });
      }
      for (const message of [...page.messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
        if (
          message.workspaceId !== rules.workspaceId ||
          Number(message.ts) < Number(after) ||
          Number(message.ts) > Number(before)
        ) {
          return yield* new Source.SlackCollectionError({
            stage: "source",
            cause: "Message outside requested window",
          });
        }
        if (!acceptsSlackMessage(rules, message)) {
          result.ignored++;
          continue;
        }
        const outcome = yield* tasks
          .ingestSlack(message)
          .pipe(
            Effect.mapError(
              (cause) => new Source.SlackCollectionError({ stage: "storage", cause }),
            ),
          );
        result[outcome]++;
      }
      cursor = page.nextCursor;
      yield* sql`UPDATE slack_task_collection SET checkpoint = ${cursor ? state.checkpoint : before},
        window_end = ${cursor ? before : null}, cursor = ${cursor} WHERE workspace_id = ${rules.workspaceId}`.pipe(
        Effect.mapError((cause) => new Source.SlackCollectionError({ stage: "storage", cause })),
      );
      if (cursor === null) return result;
    }
    result.pending = true;
    return result;
  }, lock.withPermits(1));
  return SlackTaskCollector.of({ sync, status });
});
export const layer = Layer.effect(SlackTaskCollector, make);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* SlackTaskCollector;
    yield* RuntimeAdmission.admit(service.sync()).pipe(
      Effect.catch(() =>
        Effect.logWarning("Slack task collection failed; the next pass will retry."),
      ),
      Effect.repeat(Schedule.spaced("60 seconds")),
      Effect.forkScoped,
    );
  }),
);
