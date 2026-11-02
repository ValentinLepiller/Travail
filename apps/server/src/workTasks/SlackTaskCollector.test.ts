import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Collector from "./SlackTaskCollector.ts";
import * as Source from "./SlackTaskSource.ts";
import type {
  SlackTaskRules,
  SlackCollectionInput,
  SlackCollectionPage,
} from "./slackTaskRules.ts";

const rules: SlackTaskRules = {
  enabled: true,
  workspaceId: "TTEST",
  excludeChannelNames: ["le-fond", "general"],
  excludeAuthorIds: [],
  excludeText: [],
  collector: { executable: "unused", args: [], cwd: "/tmp", codexHome: "/tmp" },
};
const start = 1793278000;
const message = (channelName = "cotily", offset = 1) => ({
  workspaceId: "TTEST",
  channelId: `C${channelName.toUpperCase().replace(/[^A-Z]/g, "")}`,
  channelName,
  authorId: "UCLIENT",
  ts: `${start + offset}.000001`,
  threadTs: `${start + 1}.000001`,
  text: "Message client",
});
const layerTest = (readPage: Source.SlackTaskSource["Service"]["readPage"]) =>
  Collector.layer.pipe(
    Layer.provideMerge(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Layer.provide(Layer.succeed(Source.SlackTaskSource, { readPage })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "slack-task-collector-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "starts at activation, excludes channels, reloads rules and disables without touching Slack",
  () => {
    const requests: SlackCollectionInput[] = [];
    const readPage: Source.SlackTaskSource["Service"]["readPage"] = (_, input) =>
      Effect.sync(() => {
        requests.push(input);
        return { messages: [message(), message("general"), message("le-fond")], nextCursor: null };
      });
    return Effect.gen(function* () {
      const collector = yield* Collector.SlackTaskCollector;
      const fs = yield* FileSystem.FileSystem;
      const tasks = yield* Tasks.WorkTaskService;
      const initialStatus = yield* collector.status();
      const configPath = initialStatus.rulesPath;
      expect(initialStatus).toMatchObject({ configured: false, excludeChannelNames: [] });
      expect((yield* collector.sync()).enabled).toBe(false);
      yield* TestClock.setTime(start * 1000);
      yield* fs.writeFileString(configPath, JSON.stringify(rules));
      expect(yield* collector.status()).toMatchObject({
        configured: true,
        excludeChannelNames: ["le-fond", "general"],
      });
      yield* collector.sync();
      expect(requests).toHaveLength(0);
      expect((yield* collector.status()).startedAt).toBe(`${start}.000000`);
      yield* TestClock.adjust("2 minutes");
      expect(yield* collector.sync()).toMatchObject({ created: 1, ignored: 2 });
      expect(requests[0]?.after).toBe(`${start}.000000`);
      expect((yield* tasks.list())[0]?.status).toBe("unqualified");
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ ...rules, excludeChannelNames: [...rules.excludeChannelNames, "cotily"] }),
      );
      expect((yield* collector.status()).excludeChannelNames).toEqual([
        "le-fond",
        "general",
        "cotily",
      ]);
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
    const requests: SlackCollectionInput[] = [];
    const readPage: Source.SlackTaskSource["Service"]["readPage"] = (_, input) => {
      requests.push(input);
      if (input.cursor === "page2" && fail)
        return Effect.fail(new Source.SlackCollectionError({ stage: "source", cause: "offline" }));
      const page: SlackCollectionPage =
        input.cursor === null
          ? { messages: [message()], nextCursor: "page2" }
          : { messages: [message("cotily", 2)], nextCursor: null };
      return Effect.succeed(page);
    };
    return Effect.gen(function* () {
      const collector = yield* Collector.SlackTaskCollector;
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
      expect((yield* collector.sync()).appended).toBe(1);
      expect(requests[2]?.before).toBe(requests[0]?.before);
      expect((yield* collector.status()).pending).toBe(false);
      expect(yield* tasks.messages((yield* tasks.list())[0]!.id)).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layerTest(readPage)));
  },
);

it.effect(
  "rejects malformed rules and messages outside the requested window without advancing",
  () =>
    Effect.gen(function* () {
      const collector = yield* Collector.SlackTaskCollector;
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
