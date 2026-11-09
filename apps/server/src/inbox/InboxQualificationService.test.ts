import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Inbox from "./MessageInbox.ts";
import * as Jev from "./JevClient.ts";
import * as Queue from "./InboxQualificationService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const gmail = (id: string) => ({
  accountEmail: "me@example.com",
  id,
  threadId: "thread",
  receivedAt: "1793278000.000001",
  sender: "Other",
  subject: "Subject",
  text: id,
});
const slack = {
  workspaceId: "TTEST",
  channelId: "CTEST",
  channelName: "test",
  authorId: "OTHER",
  ts: "1793278000.000001",
  threadTs: "1793278000.000001",
  text: "Slack",
};
const context = {
  version: 1 as const,
  checkedAt: "2026-11-08T12:00:00Z",
  status: "ready" as const,
  messages: [],
  reason: null,
  truncated: false,
};
const response = {
  model: "jev-1.14.0",
  answers: {
    qualification: {
      type: "choice",
      choice: "no_action",
      confidence: 0.9,
      probabilities: {
        no_action: 0.8,
        information: 0.05,
        personal_action: 0.05,
        technical_action: 0.05,
        unsure: 0.05,
      },
    },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
};
const layer = (evaluate: Jev.JevClient["Service"]["evaluate"], database = Sqlite.layerMemory) =>
  Queue.layer.pipe(
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(database),
    Layer.provide(Layer.succeed(Jev.JevClient, { evaluate })),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "inbox-jev-" })),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "qualifies in arrival order across sources, keeps archives and permits collection while exactly one Jev request is in flight",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const calls: string[] = [];
      let active = 0,
        maximum = 0;
      yield* Effect.gen(function* () {
        const inbox = yield* Inbox.MessageInbox,
          queue = yield* Queue.InboxQualificationService,
          sql = yield* SqlClient.SqlClient;
        yield* inbox.ingestGmail(gmail("first"));
        yield* inbox.ingestSlack(slack);
        for (const entry of (yield* inbox.list({})).messages)
          yield* inbox.setContext(entry.id, context);
        yield* queue.setEnabled(true);
        const first = yield* queue.processNext().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* inbox.ingestGmail(gmail("third"));
        yield* inbox.setContext("gmail:me@example.com:third", context);
        const competing = yield* queue.processNext().pipe(Effect.forkChild);
        expect(calls).toEqual(["first"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(competing);
        yield* Effect.all([queue.processNext(), queue.processNext()], { concurrency: "unbounded" });
        expect(maximum).toBe(1);
        expect(calls).toEqual(["first", "Slack", "third"]);
        expect(yield* queue.status()).toMatchObject({
          qualified: 3,
          remaining: 0,
          categories: { no_action: 3 },
          usage: { input_tokens: 300 },
        });
        expect(
          (yield* inbox.list({})).messages.every(
            (m) => m.context && m.qualification?.category === "no_action",
          ),
        ).toBe(true);
        expect(yield* sql`SELECT id FROM work_tasks`).toEqual([]);
      }).pipe(
        Effect.provide(
          layer((entry) =>
            Effect.gen(function* () {
              calls.push(entry.source.message.text);
              active++;
              maximum = Math.max(maximum, active);
              if (calls.length === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              active--;
              return response;
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "waits for the oldest context, preserves explicit partial/unavailable context and backs off at the head on API failure",
  () => {
    const calls: string[] = [];
    let fail = true;
    return Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        queue = yield* Queue.InboxQualificationService;
      yield* inbox.ingestGmail(gmail("old"));
      yield* inbox.ingestGmail(gmail("new"));
      yield* inbox.setContext("gmail:me@example.com:new", context);
      yield* queue.setEnabled(true);
      yield* queue.processNext();
      expect(calls).toEqual([]);
      expect((yield* queue.status()).head?.state).toBe("waiting_context");
      yield* inbox.setContext("gmail:me@example.com:old", {
        ...context,
        status: "unavailable",
        reason: "source",
      });
      yield* queue.processNext();
      yield* queue.processNext();
      expect(calls).toEqual(["old"]);
      expect(yield* queue.status()).toMatchObject({
        qualified: 0,
        errors: 1,
        head: { state: "error" },
      });
      fail = false;
      yield* TestClock.adjust("30 seconds");
      yield* queue.processNext();
      yield* queue.processNext();
      expect(calls).toEqual(["old", "old", "new"]);
      expect(yield* queue.status()).toMatchObject({ qualified: 2, errors: 0 });
      expect((yield* inbox.read({ id: "gmail:me@example.com:old" })).context?.status).toBe(
        "unavailable",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer((entry) => {
          calls.push(entry.source.message.text);
          return fail ? Effect.fail(new Jev.JevError({ reason: "api" })) : Effect.succeed(response);
        }),
      ),
    );
  },
);

it.effect(
  "rejects invalid probabilities or model without storing a false success and resumes expired processing leases",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        queue = yield* Queue.InboxQualificationService,
        sql = yield* SqlClient.SqlClient;
      yield* inbox.ingestGmail(gmail("invalid"));
      yield* inbox.setContext("gmail:me@example.com:invalid", context);
      yield* queue.setEnabled(true);
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.futureField','kept','$.qualificationAttempt',json('{"status":"processing","token":"crashed","attempts":1,"nextAttemptAt":"1970-01-01T00:00:00.000Z","error":null}'))`;
      yield* queue.processNext();
      const entry = yield* inbox.read({ id: "gmail:me@example.com:invalid" });
      expect(entry.qualification).toBeUndefined();
      expect(entry.qualificationAttempt).toMatchObject({
        status: "error",
        error: "format",
        attempts: 2,
      });
      expect(
        (yield* sql<{
          x: string;
        }>`SELECT json_extract(payload_json,'$.futureField') AS x FROM message_inbox`)[0]?.x,
      ).toBe("kept");
      expect(entry.source.message.text).toBe("invalid");
    }).pipe(
      Effect.scoped,
      Effect.provide(layer(() => Effect.succeed({ ...response, model: "other" }))),
    ),
);

it.effect(
  "resumes a durable queue after reopening SQLite without requalifying finished entries",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "inbox-jev-reopen-" });
      const db = Sqlite.layerFromPath(`${dir}/state.sqlite`);
      const config = yield* Config.ServerConfig;
      const calls: string[] = [];
      const isolated = Queue.layer.pipe(
        Layer.provideMerge(Inbox.layer),
        Layer.provideMerge(db),
        Layer.provide(
          Layer.succeed(Jev.JevClient, {
            evaluate: (entry) => {
              calls.push(entry.id);
              return Effect.succeed(response);
            },
          }),
        ),
        Layer.provide(Layer.succeed(Config.ServerConfig, config)),
      );
      yield* Effect.gen(function* () {
        const inbox = yield* Inbox.MessageInbox,
          queue = yield* Queue.InboxQualificationService;
        yield* inbox.ingestGmail(gmail("first"));
        yield* inbox.ingestGmail(gmail("second"));
        for (const entry of (yield* inbox.list({})).messages)
          yield* inbox.setContext(entry.id, context);
        yield* queue.setEnabled(true);
        yield* queue.processNext();
      }).pipe(Effect.provide(isolated));
      yield* Effect.gen(function* () {
        const queue = yield* Queue.InboxQualificationService;
        expect(yield* queue.status()).toMatchObject({ enabled: true, qualified: 1, remaining: 1 });
        yield* queue.processNext();
        yield* queue.processNext();
        expect(yield* queue.status()).toMatchObject({ qualified: 2, remaining: 0 });
      }).pipe(Effect.provide(isolated));
      expect(calls).toEqual(["gmail:me@example.com:first", "gmail:me@example.com:second"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Config.layerTest(process.cwd(), { prefix: "inbox-jev-control-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("does not overwrite a completed qualification when an older attempt finishes", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const queue = yield* Queue.InboxQualificationService,
        inbox = yield* Inbox.MessageInbox,
        sql = yield* SqlClient.SqlClient;
      yield* inbox.ingestGmail(gmail("race"));
      yield* inbox.setContext("gmail:me@example.com:race", context);
      yield* queue.setEnabled(true);
      const run = yield* queue.processNext().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const winner = {
        version: 1,
        status: "qualified",
        category: "no_action",
        model: "jev-1.14.0",
        qualifiedAt: "2026-11-08T12:00:00Z",
        probabilities: response.answers.qualification.probabilities,
        confidence: 0.9,
        usage: response.usage,
      };
      const encoded = yield* encodeJson(winner);
      yield* sql`UPDATE message_inbox SET payload_json=json_remove(json_set(payload_json,'$.qualification',json(${encoded})),'$.qualificationAttempt')`;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      expect(
        (yield* inbox.read({ id: "gmail:me@example.com:race" })).qualification?.qualifiedAt,
      ).toBe(winner.qualifiedAt);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return response;
          }),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
