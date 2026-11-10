import {
  seedLegacySlackTask,
  seedLegacyGmailTask,
  taskImageTestLayer,
} from "../workTasks/WorkTaskService.testkit.ts";
import { expect, it } from "@effect/vitest";
import { AgentRequestCreate, ThreadId, type SlackTaskMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "../workTasks/WorkTaskService.ts";
import * as Requests from "./AgentRequestService.ts";
import * as RequestEffects from "./RequestEffects.ts";

const threadId = ThreadId.make("source-preview-thread");
const proposal = Schema.decodeSync(AgentRequestCreate)({
  id: "source-request",
  context: "Une demande à examiner",
  question: "Valider ?",
  details: "",
  kind: "approval",
  action: null,
});
const message: SlackTaskMessage = {
  workspaceId: "TTEST",
  channelId: "CSOURCE",
  channelName: "projet",
  ts: "1793278000.000001",
  threadTs: "1793278000.000001",
  authorId: "UAUTHOR",
  text: "Le message initial",
};
const taskId = `slack:${message.workspaceId}:${message.channelId}:${message.ts}`;
const services = Layer.merge(
  Tasks.layer.pipe(Layer.provide(taskImageTestLayer)),
  Requests.layer,
).pipe(
  Layer.provide(
    Layer.succeed(RequestEffects.RequestEffects, {
      execute: () => Effect.die("must not execute"),
      notify: () => Effect.void,
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("selects the exact Slack reply, keeps its link and freezes it across revisions", () =>
  Effect.gen(function* () {
    const requests = yield* Requests.AgentRequestService;
    yield* seedLegacySlackTask(message);
    const reply = {
      ...message,
      ts: "1793278001.000002",
      text: "Le message concerné <script>alert(1)</script>",
    };
    yield* seedLegacySlackTask(reply);
    const created = yield* requests.create(threadId, {
      ...proposal,
      sourceTaskId: `slack:TTEST:CSOURCE:${reply.ts}`,
    });
    expect(created.source).toMatchObject({
      kind: "slack",
      text: reply.text,
      author: reply.authorId,
      url: "https://app.slack.com/archives/CSOURCE/p1793278001000002",
    });
    yield* requests.update(threadId, { ...proposal, expectedVersion: 1, withdraw: false });
    expect((yield* requests.list())[0]?.source).toEqual(created.source);
    yield* requests.update(threadId, {
      ...proposal,
      sourceTaskId: taskId,
      expectedVersion: 2,
      withdraw: false,
    });
    expect((yield* requests.list())[0]?.source?.text).toBe(message.text);
    yield* requests.update(threadId, {
      ...proposal,
      source: null,
      expectedVersion: 3,
      withdraw: false,
    });
    expect((yield* requests.list())[0]?.source).toBeNull();
  }).pipe(Effect.provide(services)),
);

it.effect(
  "never assigns a batch's first message to every request; legacy single-task requests resolve",
  () =>
    Effect.gen(function* () {
      const requests = yield* Requests.AgentRequestService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacySlackTask(message);
      yield* sql`INSERT INTO autonomous_agents (id, payload_json) VALUES ('qualifier', '{"name":"Qualifieur","trigger":"unqualified"}')`;
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id, agent_id, title, prompt, started_at, task_id, task_ids_json)
      VALUES (${threadId}, 'qualifier', 'Test', '', '', ${taskId}, ${JSON.stringify([taskId, "another-task"])})`;
      const unbound = yield* requests.create(threadId, proposal);
      expect(unbound.source).toBeUndefined();
      expect((yield* requests.list())[0]?.source).toBeUndefined();
      expect(
        (yield* requests.create(threadId, { ...proposal, id: "explicit", sourceTaskId: taskId }))
          .source?.text,
      ).toBe(message.text);
      yield* sql`UPDATE autonomous_agent_runs SET task_ids_json = '[]' WHERE thread_id = ${threadId}`;
      expect((yield* requests.list())[0]?.source?.url).toBe(
        "https://app.slack.com/archives/CSOURCE/p1793278000000001",
      );
      expect(
        (yield* requests
          .create(threadId, { ...proposal, id: "missing", sourceTaskId: "missing" })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
      expect(yield* requests.list()).toHaveLength(2);
    }).pipe(Effect.provide(services)),
);

it.effect(
  "Gmail previews use collected message content rather than rewritten task notes, with the correct account link",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.WorkTaskService;
      const requests = yield* Requests.AgentRequestService;
      const sql = yield* SqlClient.SqlClient;
      const email = {
        accountEmail: "test+preview@example.com",
        id: "abc123",
        threadId: "different-thread",
        receivedAt: "1793278000.000001",
        sender: "Camille <camille@example.com>",
        subject: "Validation",
        text: "Le texte original du mail",
      };
      yield* seedLegacyGmailTask(email);
      const task = (yield* tasks.list())[0]!;
      yield* tasks.save({
        ...task,
        notes: "Une synthèse modifiée par un agent",
        expectedVersion: task.version,
      });
      const created = yield* requests.create(threadId, { ...proposal, sourceTaskId: task.id });
      expect(created.source).toMatchObject({
        kind: "email",
        author: email.sender,
        title: email.subject,
        text: email.text,
        url: "https://mail.google.com/mail/u/?authuser=test%2Bpreview%40example.com#all/abc123",
      });
      yield* sql`UPDATE work_task_gmail_messages SET payload_json = NULL`;
      const legacy = yield* requests.create(threadId, {
        ...proposal,
        id: "legacy",
        sourceTaskId: task.id,
      });
      expect(legacy.source?.text).toBeNull();
      expect(legacy.source?.url).toBe(created.source?.url);
      yield* sql`UPDATE work_task_gmail_messages SET payload_json=${JSON.stringify(email)} WHERE account_email=${email.accountEmail} AND message_id=${email.id}`;
      const refreshed = yield* requests.create(threadId, {
        ...proposal,
        id: "refreshed",
        sourceTaskId: task.id,
      });
      expect(refreshed.source?.text).toBe(email.text);
      expect(yield* tasks.list()).toHaveLength(1);
      expect((yield* requests.list())[0]?.source).toEqual(created.source);
    }).pipe(Effect.provide(services)),
);

it.effect(
  "other integrations preserve verbatim excerpts and links; manual requests need no source",
  () =>
    Effect.gen(function* () {
      const requests = yield* Requests.AgentRequestService;
      for (const kind of ["notion", "meeting", "quote", "other", "manual"] as const) {
        const source = {
          kind,
          label: "Compte rendu",
          url: "https://example.com/message/42",
          text: "Extrait exact\nDeuxième ligne",
        };
        const created = yield* requests.create(threadId, { ...proposal, id: kind, source });
        expect(created.source).toEqual(source);
      }
      expect((yield* requests.create(threadId, proposal)).source).toBeUndefined();
      expect(yield* requests.list()).toHaveLength(6);
    }).pipe(Effect.provide(services)),
);

it.effect("bounds large Unicode excerpts without losing their source", () =>
  Effect.gen(function* () {
    const requests = yield* Requests.AgentRequestService;
    yield* seedLegacySlackTask({ ...message, text: "😀".repeat(5000) });
    const created = yield* requests.create(threadId, { ...proposal, sourceTaskId: taskId });
    expect(created.source?.text).toBe("😀".repeat(3000));
    expect(created.source?.url).toBeTruthy();
  }).pipe(Effect.provide(services)),
);

it.effect("uses a uniquely linked task's source, but does not choose among several sources", () =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.WorkTaskService;
    const requests = yield* Requests.AgentRequestService;
    const sql = yield* SqlClient.SqlClient;
    const source = {
      kind: "notion" as const,
      label: "Décision",
      url: "https://example.com/decision/42",
    };
    yield* tasks.save({
      id: "manual-task",
      title: "Une demande",
      notes: "Une synthèse",
      sources: [source],
      status: "doing",
      projectId: null,
      agentThreadId: null,
      dueDate: null,
      expectedVersion: 0,
    });
    // Association normally set by launching/claiming the task; no agent is run in this test.
    yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.agentThreadId', ${threadId}) WHERE id = 'manual-task'`;
    expect((yield* requests.create(threadId, proposal)).source).toMatchObject({
      ...source,
      text: null,
    });
    yield* tasks.save({
      id: "many-sources",
      title: "Plusieurs sources",
      notes: "",
      sources: [source, { ...source, url: "https://example.com/decision/43" }],
      status: "ready",
      projectId: null,
      agentThreadId: null,
      dueDate: null,
      expectedVersion: 0,
    });
    expect(
      (yield* requests
        .create(threadId, { ...proposal, id: "ambiguous", sourceTaskId: "many-sources" })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid");
  }).pipe(Effect.provide(services)),
);
