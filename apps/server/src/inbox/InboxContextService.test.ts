import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Inbox from "./MessageInbox.ts";
import * as Contexts from "./InboxContextService.ts";
import * as Source from "./InboxContextSource.ts";
const message = (n: number) => ({
  workspaceId: "TTEST",
  channelId: "CTEST",
  channelName: "projet",
  authorId: "UCLIENT",
  ts: `17939754${String(n).padStart(2, "0")}.000001`,
  threadTs: "1793975400.000001",
  text: `Message ${n}`,
});
const layer = (read: Source.InboxContextSource["Service"]["read"]) =>
  Contexts.layer.pipe(
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Layer.succeed(Source.InboxContextSource, { read })),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "inbox-context-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
it.effect(
  "adds context in place while keeping the original source, collectedAt, ID and unrelated fields",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        contexts = yield* Contexts.InboxContextService,
        sql = yield* SqlClient.SqlClient;
      yield* inbox.ingestSlack(message(5));
      const before = (yield* inbox.list({})).messages[0]!;
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.futureField','preserved')`;
      const context = yield* contexts.enrich(before.id);
      expect(context).toMatchObject({ version: 1, status: "ready" });
      expect(context.messages).toHaveLength(1);
      const after = yield* inbox.read({ id: before.id });
      const { context: _, ...original } = after;
      expect(original).toEqual(before);
      expect(
        (yield* sql<{
          x: string;
        }>`SELECT json_extract(payload_json,'$.futureField') AS x FROM message_inbox`)[0]?.x,
      ).toBe("preserved");
      expect((yield* inbox.list({})).messages).toHaveLength(1);
      expect(yield* sql`SELECT id FROM work_tasks`).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer(() =>
          Effect.succeed({
            status: "ready",
            messages: [{ kind: "slack", message: { ...message(2), authorId: "USELF" } }],
            truncated: false,
            reason: null,
          }),
        ),
      ),
    ),
);
it.effect(
  "stores an unavailable status after connector failure, rather than a successful empty context",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        contexts = yield* Contexts.InboxContextService;
      yield* inbox.ingestSlack(message(5));
      expect(yield* contexts.enrich((yield* inbox.list({})).messages[0]!.id)).toMatchObject({
        status: "unavailable",
        reason: "source",
        messages: [],
      });
      expect((yield* inbox.list({})).messages[0]?.source.message.text).toBe("Message 5");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer(() =>
          Effect.fail(new Source.InboxContextSourceError({ reason: "source", cause: "offline" })),
        ),
      ),
    ),
);
it.effect("rejects mixed context and excludes future and equal-time messages before storage", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MessageInbox,
      contexts = yield* Contexts.InboxContextService;
    yield* inbox.ingestSlack(message(5));
    yield* inbox.ingestSlack(message(6));
    const entries = (yield* inbox.list({})).messages;
    expect((yield* contexts.enrich(entries[0]!.id)).messages).toHaveLength(0);
    expect(yield* contexts.enrich(entries[1]!.id)).toMatchObject({
      status: "unavailable",
      reason: "format",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layer((source) =>
        Effect.succeed({
          status: "ready",
          messages: [
            {
              kind: "slack",
              message: {
                ...message(7),
                channelId: source.message.text === "Message 6" ? "COTHER" : "CTEST",
              },
            },
          ],
          truncated: false,
          reason: null,
        }),
      ),
    ),
  ),
);
it.effect(
  "resumes a bounded backfill after interruption and covers only the initial snapshot without creating entries/tasks",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        contexts = yield* Contexts.InboxContextService,
        fs = yield* FileSystem.FileSystem,
        config = yield* Config.ServerConfig,
        sql = yield* SqlClient.SqlClient;
      for (let n = 1; n <= 4; n++) yield* inbox.ingestSlack(message(n));
      const first = yield* contexts.backfill({ limit: 1 });
      expect(first).toMatchObject({
        targets: 4,
        reviewed: 1,
        updated: 1,
        withContext: 1,
        remaining: 3,
      });
      yield* inbox.ingestSlack(message(8));
      // Emulate interruption after committing entry 2's context but before advancing the durable cursor.
      const ids = (yield* inbox.list({})).messages.map((x) => x.id);
      yield* contexts.enrich(ids[1]!, first.batchId);
      const second = yield* Effect.gen(function* () {
        const restarted = yield* Contexts.InboxContextService;
        return yield* restarted.backfill({ limit: 1 });
      }).pipe(Effect.provide(Contexts.layer));
      expect(second).toMatchObject({ reviewed: 2, updated: 2, remaining: 2 });
      expect(calls).toBe(2);
      expect(yield* fs.readFileString(config.stateDir + "/inbox-context-backfill.json")).toContain(
        first.batchId,
      );
      const final = yield* contexts.backfill({ limit: 5 });
      expect(final).toMatchObject({
        targets: 4,
        reviewed: 4,
        updated: 4,
        withContext: 1,
        empty: 1,
        failed: 2,
        partial: 1,
        remaining: 0,
      });
      expect(yield* contexts.backfill({})).toEqual(final);
      expect(calls).toBe(4);
      expect((yield* inbox.list({})).messages).toHaveLength(5);
      expect((yield* inbox.read({ id: ids[4]! })).context).toBeUndefined();
      expect(yield* sql`SELECT id FROM work_tasks`).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer((source) => {
          calls++;
          const text = source.message.text;
          return text === "Message 3"
            ? Effect.fail(
                new Source.InboxContextSourceError({ reason: "source", cause: "offline" }),
              )
            : Effect.succeed({
                status: text === "Message 4" ? "partial" : "ready",
                messages: text === "Message 1" ? [{ kind: "slack", message: message(0) }] : [],
                truncated: text === "Message 4",
                reason: text === "Message 4" ? "limit" : null,
              });
        }),
      ),
    );
  },
);

it.effect(
  "reports already processed entries separately, without calling a review a new enrichment",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        contexts = yield* Contexts.InboxContextService;
      yield* inbox.ingestSlack(message(5));
      yield* inbox.ingestSlack(message(6));
      yield* contexts.enrich((yield* inbox.list({})).messages[0]!.id);
      expect(yield* contexts.backfill({ limit: 5 })).toMatchObject({
        targets: 2,
        reviewed: 2,
        updated: 1,
        alreadyProcessed: 1,
        withContext: 1,
        empty: 0,
        failed: 0,
        remaining: 0,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer(() =>
          Effect.succeed({
            status: "ready",
            messages: [{ kind: "slack", message: message(0) }],
            truncated: false,
            reason: null,
          }),
        ),
      ),
    ),
);

it.effect("retries only explicit unavailable snapshot entries in place after completion", () => {
  let recovered = false,
    calls = 0;
  return Effect.gen(function* () {
    const inbox = yield* Inbox.MessageInbox,
      contexts = yield* Contexts.InboxContextService,
      fs = yield* FileSystem.FileSystem,
      config = yield* Config.ServerConfig,
      sql = yield* SqlClient.SqlClient;
    yield* inbox.ingestSlack(message(1));
    yield* inbox.ingestSlack(message(2));
    const before = (yield* inbox.list({})).messages;
    yield* contexts.backfill({ limit: 1 });
    expect(
      yield* contexts.backfill({ retryUnavailableIds: [before[1]!.id] }).pipe(Effect.flip),
    ).toBeInstanceOf(Contexts.InboxContextError);
    const initial = yield* contexts.backfill({ limit: 5 });
    expect(initial).toMatchObject({
      targets: 2,
      reviewed: 2,
      withContext: 1,
      failed: 1,
      remaining: 0,
    });
    const state = yield* fs.readFileString(config.stateDir + "/inbox-context-backfill.json");
    yield* inbox.ingestSlack(message(3));
    const outside = (yield* inbox.list({})).messages[2]!;
    yield* contexts.enrich(outside.id);
    recovered = true;
    const final = yield* contexts.backfill({
      retryUnavailableIds: [before[0]!.id, before[1]!.id, outside.id],
    });
    expect(final).toMatchObject({
      targets: 2,
      reviewed: 2,
      updated: 2,
      withContext: 2,
      failed: 0,
      remaining: 0,
    });
    expect(calls).toBe(4);
    expect(yield* contexts.backfill({ retryUnavailableIds: [before[1]!.id] })).toEqual(final);
    expect(calls).toBe(4);
    expect(yield* fs.readFileString(config.stateDir + "/inbox-context-backfill.json")).toBe(state);
    expect((yield* inbox.read({ id: before[0]!.id })).context?.checkedAt).toBeDefined();
    expect((yield* inbox.read({ id: outside.id })).context?.status).toBe("unavailable");
    for (const entry of before) {
      const { context: _, ...original } = yield* inbox.read({ id: entry.id });
      expect(original).toEqual(entry);
    }
    expect((yield* inbox.list({})).messages).toHaveLength(3);
    expect(yield* sql`SELECT id FROM work_tasks`).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layer((source) => {
        calls++;
        return source.message.text !== "Message 1" && !recovered
          ? Effect.fail(
              new Source.InboxContextSourceError({ reason: "source", cause: "old parser" }),
            )
          : Effect.succeed({
              status: "ready",
              messages: [{ kind: "slack", message: message(0) }],
              truncated: false,
              reason: null,
            });
      }),
    ),
  );
});
