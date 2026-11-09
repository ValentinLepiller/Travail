import { taskImageTestLayer } from "./WorkTaskService.testkit.ts";
import * as Contexts from "../inbox/InboxContextService.ts";
import * as ContextSource from "../inbox/InboxContextSource.ts";
import * as Inbox from "../inbox/MessageInbox.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Collector from "./GmailTaskCollector.ts";
import * as Source from "./GmailTaskSource.ts";
import type {
  GmailTaskRules,
  GmailCollectionInput,
  GmailCollectionPage,
} from "./gmailTaskRules.ts";

const rules: GmailTaskRules = {
  enabled: true,
  accountEmail: "me@example.com",
  excludeSenders: ["le-fond", "general"],
  excludeText: [],
  collector: { executable: "unused", args: [], cwd: "/tmp", codexHome: "/tmp" },
};
const start = 1793278000;
const message = (sender = "cotily", offset = 1) => ({
  accountEmail: "me@example.com",
  id: `${sender}-${offset}`,
  threadId: "thread",
  sender,
  subject: "Demande client",
  receivedAt: `${start + offset}.000001`,
  text: "Message client",
});
const layerTest = (
  readPage: Source.GmailTaskSource["Service"]["readPage"],
  readContext: ContextSource.InboxContextSource["Service"]["read"] = () =>
    Effect.succeed({ status: "ready", messages: [], truncated: false, reason: null }),
) =>
  Collector.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Inbox.layer,
        Tasks.layer.pipe(Layer.provide(taskImageTestLayer)),
        Contexts.layer.pipe(
          Layer.provide(Inbox.layer),
          Layer.provide(Layer.succeed(ContextSource.InboxContextSource, { read: readContext })),
        ),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
    Layer.provide(Layer.succeed(Source.GmailTaskSource, { readPage })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "gmail-task-collector-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "starts at activation, excludes channels, reloads rules and disables without touching Gmail",
  () => {
    const requests: GmailCollectionInput[] = [];
    const readPage: Source.GmailTaskSource["Service"]["readPage"] = (_, input) =>
      Effect.sync(() => {
        requests.push(input);
        return { messages: [message(), message("general"), message("le-fond")], nextCursor: null };
      });
    return Effect.gen(function* () {
      const collector = yield* Collector.GmailTaskCollector;
      const fs = yield* FileSystem.FileSystem;
      const tasks = yield* Tasks.WorkTaskService;
      const inbox = yield* Inbox.MessageInbox;
      const configPath = (yield* collector.status()).rulesPath;
      expect((yield* collector.sync()).enabled).toBe(false);
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString(configPath, JSON.stringify(rules));
      yield* collector.sync();
      expect(requests).toHaveLength(0);
      expect((yield* collector.status()).startedAt).toBe(`${start}.000000`);
      yield* TestClock.adjust("2 minutes");
      expect(yield* collector.sync()).toMatchObject({ created: 1, ignored: 2 });
      expect(requests[0]?.after).toBe(`${start}.000000`);
      expect((yield* inbox.list({})).messages).toHaveLength(1);
      expect(yield* tasks.list()).toEqual([]);
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ ...rules, excludeSenders: [...rules.excludeSenders, "cotily"] }),
      );
      expect((yield* collector.sync()).ignored).toBe(3);
      yield* fs.writeFileString(configPath, JSON.stringify({ ...rules, enabled: false }));
      expect((yield* collector.sync()).enabled).toBe(false);
      expect(requests).toHaveLength(2);
      expect((yield* inbox.list({})).messages).toHaveLength(1);
      expect(yield* tasks.list()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest(readPage)));
  },
);

it.effect(
  "resumes the same paginated window after a failure without duplicating stored messages",
  () => {
    let fail = true;
    const requests: GmailCollectionInput[] = [];
    const readPage: Source.GmailTaskSource["Service"]["readPage"] = (_, input) => {
      requests.push(input);
      if (input.cursor === "page2" && fail)
        return Effect.fail(new Source.GmailCollectionError({ stage: "source", cause: "offline" }));
      const page: GmailCollectionPage =
        input.cursor === null
          ? { messages: [message()], nextCursor: "page2" }
          : { messages: [message("cotily", 2)], nextCursor: null };
      return Effect.succeed(page);
    };
    return Effect.gen(function* () {
      const collector = yield* Collector.GmailTaskCollector;
      const fs = yield* FileSystem.FileSystem;
      const tasks = yield* Tasks.WorkTaskService;
      const inbox = yield* Inbox.MessageInbox;
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
      yield* collector.sync();
      yield* TestClock.adjust("2 minutes");
      expect((yield* collector.sync().pipe(Effect.flip)).stage).toBe("source");
      expect((yield* collector.status()).pending).toBe(true);
      expect((yield* inbox.list({})).messages).toHaveLength(1);
      expect(yield* tasks.list()).toEqual([]);
      fail = false;
      yield* TestClock.adjust("5 minutes");
      expect((yield* collector.sync()).created).toBe(1);
      expect(requests[2]?.before).toBe(requests[0]?.before);
      expect((yield* collector.status()).pending).toBe(false);
      expect((yield* inbox.list({})).messages).toHaveLength(2);
      expect(yield* tasks.list()).toEqual([]);
      expect(yield* collector.sync()).toMatchObject({ created: 0, duplicate: 2, appended: 0 });
      expect((yield* inbox.list({})).messages).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layerTest(readPage)));
  },
);

it.effect(
  "rejects malformed rules and messages outside the requested window without advancing",
  () =>
    Effect.gen(function* () {
      const collector = yield* Collector.GmailTaskCollector;
      const fs = yield* FileSystem.FileSystem;
      const tasks = yield* Tasks.WorkTaskService;
      const inbox = yield* Inbox.MessageInbox;
      const path = (yield* collector.status()).rulesPath;
      yield* fs.writeFileString(path, "{}");
      expect((yield* collector.sync().pipe(Effect.flip)).stage).toBe("configuration");
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString(path, JSON.stringify(rules));
      yield* collector.sync();
      yield* TestClock.adjust("2 minutes");
      expect((yield* collector.sync().pipe(Effect.flip)).stage).toBe("source");
      expect((yield* collector.status()).checkpoint).toBe(`${start}.000000`);
      expect(yield* tasks.list()).toEqual([]);
      expect((yield* inbox.list({})).messages).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest(() => Effect.succeed({ messages: [message("cotily", -1)], nextCursor: null })),
      ),
    ),
);

it.effect(
  "keeps existing tasks and resumes the saved cursor without reimporting their messages",
  () => {
    const requests: GmailCollectionInput[] = [];
    return Effect.gen(function* () {
      const collector = yield* Collector.GmailTaskCollector;
      const tasks = yield* Tasks.WorkTaskService;
      const inbox = yield* Inbox.MessageInbox;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      yield* tasks.ingestGmail(message());
      const previous = yield* tasks.list();
      yield* sql`INSERT INTO gmail_task_collection (account_email, started_at, checkpoint, window_end, cursor)
        VALUES (${rules.accountEmail}, ${`${start}.000000`}, ${`${start + 40}.000000`}, ${`${start + 90}.000000`}, 'existing-page')`;
      yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
      yield* TestClock.setTime((start + 200) * 1000);
      expect(yield* collector.sync()).toMatchObject({ created: 1, duplicate: 1, appended: 0 });
      expect(requests[0]).toMatchObject({
        cursor: "existing-page",
        before: `${start + 90}.000000`,
      });
      expect((yield* collector.status()).startedAt).toBe(`${start}.000000`);
      expect(yield* tasks.list()).toEqual(previous);
      expect((yield* inbox.list({})).messages).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest((_, input) => {
          requests.push(input);
          return Effect.succeed({ messages: [message(), message("cotily", 2)], nextCursor: null });
        }),
      ),
    );
  },
);

it.effect(
  "replays a partially stored page after storage failure without losing or duplicating messages",
  () =>
    Effect.gen(function* () {
      const collector = yield* Collector.GmailTaskCollector;
      const inbox = yield* Inbox.MessageInbox;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
      yield* collector.sync();
      yield* TestClock.adjust("2 minutes");
      yield* sql`CREATE TRIGGER fail_second BEFORE INSERT ON message_inbox
      WHEN json_extract(NEW.payload_json, '$.source.message.text') = 'Second'
      BEGIN SELECT RAISE(ABORT, 'isolated storage failure'); END`;
      expect((yield* collector.sync().pipe(Effect.flip)).stage).toBe("storage");
      expect((yield* collector.status()).checkpoint).toBe(`${start}.000000`);
      expect((yield* inbox.list({})).messages).toHaveLength(1);
      yield* sql`DROP TRIGGER fail_second`;
      expect(yield* collector.sync()).toMatchObject({ created: 1, duplicate: 1 });
      expect((yield* inbox.list({})).messages).toHaveLength(2);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest(() =>
          Effect.succeed({
            messages: [message(), { ...message("cotily", 2), text: "Second" }],
            nextCursor: null,
          }),
        ),
      ),
    ),
);

it.effect("continues after the ten-page budget from the persisted cursor and same window", () => {
  const requests: GmailCollectionInput[] = [];
  return Effect.gen(function* () {
    const collector = yield* Collector.GmailTaskCollector;
    const fs = yield* FileSystem.FileSystem;
    const inbox = yield* Inbox.MessageInbox;
    yield* TestClock.setTime(start * 1000);
    yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
    yield* collector.sync();
    yield* TestClock.adjust("2 minutes");
    expect(yield* collector.sync()).toMatchObject({ created: 10, pending: true });
    yield* TestClock.adjust("5 minutes");
    expect(yield* collector.sync()).toMatchObject({ created: 1, pending: false });
    expect(requests[10]).toMatchObject({ cursor: "10", before: requests[0]!.before });
    expect((yield* inbox.list({})).messages).toHaveLength(11);
    expect(yield* (yield* Tasks.WorkTaskService).list()).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerTest((_, input) => {
        requests.push(input);
        const page = Number(input.cursor ?? "0");
        return Effect.succeed({
          messages: [message("cotily", page + 1)],
          nextCursor: page === 10 ? null : String(page + 1),
        });
      }),
    ),
  );
});

it.effect("keeps a newly collected principal and progress when context fetching fails", () =>
  Effect.gen(function* () {
    const collector = yield* Collector.GmailTaskCollector,
      fs = yield* FileSystem.FileSystem,
      inbox = yield* Inbox.MessageInbox;
    yield* TestClock.setTime(start * 1000);
    yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
    yield* collector.sync();
    yield* TestClock.adjust("2 minutes");
    expect(yield* collector.sync()).toMatchObject({ created: 1 });
    const entry = (yield* inbox.list({})).messages[0]!;
    expect(entry.source.message.text).toBe("Message client");
    expect(entry.context).toMatchObject({ status: "unavailable", reason: "source" });
    expect((yield* collector.status()).checkpoint).not.toBe(`${start}.000000`);
    expect(yield* (yield* Tasks.WorkTaskService).list()).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      layerTest(
        () => Effect.succeed({ messages: [message()], nextCursor: null }),
        () =>
          Effect.fail(
            new ContextSource.InboxContextSourceError({ reason: "source", cause: "offline" }),
          ),
      ),
    ),
  ),
);
