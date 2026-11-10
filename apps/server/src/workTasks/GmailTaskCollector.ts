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
import * as Inbox from "../inbox/MessageInbox.ts";
import * as Source from "./GmailTaskSource.ts";
import { GmailTaskRules, acceptsGmailMessage } from "./gmailTaskRules.ts";

const decodeRules = Schema.decodeEffect(Schema.fromJsonString(GmailTaskRules));

export const GmailTaskSyncResult = Schema.Struct({
  enabled: Schema.Boolean,
  // Keep the existing result shape; created now counts inbox messages and appended stays zero.
  created: Schema.Number,
  appended: Schema.Number,
  duplicate: Schema.Number,
  ignored: Schema.Number,
  pending: Schema.Boolean,
});
export const GmailTaskCollectionStatus = Schema.Struct({
  rulesPath: Schema.String,
  enabled: Schema.Boolean,
  accountEmail: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  checkpoint: Schema.NullOr(Schema.String),
  pending: Schema.Boolean,
});

export class GmailTaskCollector extends Context.Service<
  GmailTaskCollector,
  {
    readonly sync: () => Effect.Effect<
      typeof GmailTaskSyncResult.Type,
      Source.GmailCollectionError
    >;
    readonly status: () => Effect.Effect<
      typeof GmailTaskCollectionStatus.Type,
      Source.GmailCollectionError
    >;
  }
>()("t3/workTasks/GmailTaskCollector") {}

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
  const inbox = yield* Inbox.MessageInbox;
  const source = yield* Source.GmailTaskSource;
  const lock = yield* Semaphore.make(1);
  const rulesPath = path.join(config.stateDir, "gmail-task-rules.json");
  const readRules = Effect.fn("GmailTaskCollector.readRules")(
    function* () {
      const raw = yield* fs.readFileString(rulesPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      return raw === null ? null : yield* decodeRules(raw);
    },
    Effect.mapError((cause) => new Source.GmailCollectionError({ stage: "configuration", cause })),
  );
  const readState = (accountEmail: string) =>
    sql<CollectionState>`SELECT started_at, checkpoint, window_end, cursor
    FROM gmail_task_collection WHERE account_email = ${accountEmail}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError((cause) => new Source.GmailCollectionError({ stage: "storage", cause })),
    );
  const status = Effect.fn("GmailTaskCollector.status")(function* () {
    const rules = yield* readRules();
    const state = rules ? yield* readState(rules.accountEmail) : undefined;
    return {
      rulesPath,
      enabled: rules?.enabled ?? false,
      accountEmail: rules?.accountEmail ?? null,
      startedAt: state?.started_at ?? null,
      checkpoint: state?.checkpoint ?? null,
      pending: state?.window_end != null,
    };
  });
  const sync = Effect.fn("GmailTaskCollector.sync")(function* () {
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
    yield* sql`INSERT INTO gmail_task_collection (account_email, started_at, checkpoint)
      VALUES (${rules.accountEmail}, ${initial}, ${initial}) ON CONFLICT(account_email) DO NOTHING`.pipe(
      Effect.mapError((cause) => new Source.GmailCollectionError({ stage: "storage", cause })),
    );
    const state = (yield* readState(rules.accountEmail))!;
    // Leave indexing time and replay an overlap; message identities deduplicate replays.
    const before = state.window_end ?? Math.max(now - 30, Number(state.checkpoint)).toFixed(6);
    if (Number(before) <= Number(state.started_at)) return result;
    const after = Math.max(Number(state.started_at), Number(state.checkpoint) - 300).toFixed(6);
    let cursor = state.cursor;
    const collection = yield* inbox
      .collectionState({ kind: "gmail", identity: rules.accountEmail, after, before })
      .pipe(
        Effect.mapError((cause) => new Source.GmailCollectionError({ stage: "storage", cause })),
      );
    const recovery = collection.recovery.flatMap((entry) =>
      entry.kind === "gmail" ? [entry.message] : [],
    );
    const known = new Set(collection.knownIds);
    const recoveredIds = new Set(recovery.map((message) => message.id));
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = yield* source.readPage(rules.collector, {
        accountEmail: rules.accountEmail,
        after,
        before,
        cursor,
        ...(rules.collector.linkId ? { linkId: rules.collector.linkId } : {}),
        knownIds: [...known].slice(0, 2000),
        recovery: pageNumber === 0 ? recovery : [],
        excludeSenders: rules.excludeSenders,
        excludeText: rules.excludeText,
      });
      if (
        pageNumber === 0 &&
        [...recoveredIds].some((id) => !page.messages.some((message) => message.id === id))
      )
        return yield* new Source.GmailCollectionError({
          stage: "source",
          cause: "Collector omitted requested recovery",
        });
      if (page.nextCursor !== null && page.nextCursor === cursor) {
        return yield* new Source.GmailCollectionError({
          stage: "source",
          cause: "Pagination did not advance",
        });
      }
      for (const message of [...page.messages].sort(
        (a, b) => Number(a.receivedAt) - Number(b.receivedAt),
      )) {
        if (
          message.accountEmail !== rules.accountEmail ||
          (!recoveredIds.has(message.id) &&
            (Number(message.receivedAt) < Number(after) ||
              Number(message.receivedAt) > Number(before)))
        ) {
          return yield* new Source.GmailCollectionError({
            stage: "source",
            cause: "Message outside requested window",
          });
        }
        if (!recoveredIds.has(message.id) && !acceptsGmailMessage(rules, message)) {
          result.ignored++;
          continue;
        }
        if (!message.context) {
          if (!known.has(message.id))
            return yield* new Source.GmailCollectionError({
              stage: "source",
              cause: "Collector omitted message context",
            });
          result.duplicate++;
          continue;
        }
        const outcome = yield* inbox
          .ingestGmail(message, message.context)
          .pipe(
            Effect.mapError(
              (cause) => new Source.GmailCollectionError({ stage: "storage", cause }),
            ),
          );
        result[outcome]++;
        known.add(message.id);
      }
      cursor = page.nextCursor;
      yield* sql`UPDATE gmail_task_collection SET checkpoint = ${cursor ? state.checkpoint : before},
        window_end = ${cursor ? before : null}, cursor = ${cursor} WHERE account_email = ${rules.accountEmail}`.pipe(
        Effect.mapError((cause) => new Source.GmailCollectionError({ stage: "storage", cause })),
      );
      if (cursor === null) return result;
    }
    result.pending = true;
    return result;
  }, lock.withPermits(1));
  return GmailTaskCollector.of({ sync, status });
});
export const layer = Layer.effect(GmailTaskCollector, make);

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* GmailTaskCollector;
    yield* RuntimeAdmission.admit(service.sync()).pipe(
      Effect.catch(() =>
        Effect.logWarning("Gmail inbox collection failed; the next pass will retry."),
      ),
      Effect.repeat(Schedule.spaced("60 seconds")),
      Effect.forkScoped,
    );
  }),
);
