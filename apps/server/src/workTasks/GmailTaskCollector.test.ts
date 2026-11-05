import { taskImageTestLayer } from "./WorkTaskService.testkit.ts";
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
const layerTest = (readPage: Source.GmailTaskSource["Service"]["readPage"]) =>
  Collector.layer.pipe(
    Layer.provideMerge(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
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
      expect((yield* tasks.list())[0]?.status).toBe("unqualified");
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ ...rules, excludeSenders: [...rules.excludeSenders, "cotily"] }),
      );
      expect((yield* collector.sync()).ignored).toBe(3);
      yield* fs.writeFileString(configPath, JSON.stringify({ ...rules, enabled: false }));
      expect((yield* collector.sync()).enabled).toBe(false);
      expect(requests).toHaveLength(2);
      expect(yield* tasks.list()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layerTest(readPage)));
  },
);

it.effect(
  "resumes the same paginated window after a failure without duplicating committed tasks",
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
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString((yield* collector.status()).rulesPath, JSON.stringify(rules));
      yield* collector.sync();
      yield* TestClock.adjust("2 minutes");
      expect((yield* collector.sync().pipe(Effect.flip)).stage).toBe("source");
      expect((yield* collector.status()).pending).toBe(true);
      expect(yield* tasks.list()).toHaveLength(1);
      fail = false;
      yield* TestClock.adjust("5 minutes");
      expect((yield* collector.sync()).created).toBe(1);
      expect(requests[2]?.before).toBe(requests[0]?.before);
      expect((yield* collector.status()).pending).toBe(false);
      expect(yield* tasks.list()).toHaveLength(2);
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
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerTest(() => Effect.succeed({ messages: [message("cotily", -1)], nextCursor: null })),
      ),
    ),
);
