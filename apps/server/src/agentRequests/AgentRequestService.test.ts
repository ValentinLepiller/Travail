import { expect, it } from "@effect/vitest";
import { AgentRequest, AgentRequestCreate, AgentRequestError, ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Requests from "./AgentRequestService.ts";
import * as RequestEffects from "./RequestEffects.ts";

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(AgentRequest));
const threadId = ThreadId.make("request-thread");
const input = Schema.decodeSync(AgentRequestCreate)({
  id: "request-test",
  context: "Préparer une livraison",
  question: "Envoyer le message ?",
  details: "```mermaid\ngraph LR\nA-->B\n```",
  kind: "approval",
  action: {
    kind: "command",
    label: "envoyer le message",
    executable: "test-command",
    args: [],
    cwd: "/tmp",
  },
});

it.effect("approval executes once, persists the result and retries only failed notification", () =>
  Effect.gen(function* () {
    let executions = 0;
    let notifications = 0;
    let failNotification = true;
    const effects = Layer.succeed(RequestEffects.RequestEffects, {
      execute: () =>
        Effect.sync(() => {
          executions++;
          return true;
        }),
      notify: () =>
        Effect.gen(function* () {
          notifications++;
          if (failNotification) return yield* new AgentRequestError({ reason: "agent" });
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* Requests.AgentRequestService;
      const created = yield* service.create(threadId, input);
      expect(yield* service.create(threadId, input)).toEqual(created);
      expect((yield* service.create(ThreadId.make("other"), input).pipe(Effect.flip)).reason).toBe(
        "conflict",
      );
      expect(executions).toBe(0);
      yield* service.respond({ id: input.id, expectedVersion: 1, decision: "accept", text: "Oui" });
      expect(
        (yield* service
          .respond({ id: input.id, expectedVersion: 1, decision: "accept", text: "" })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      yield* service.drain();
      const result = (yield* service.list())[0]!;
      expect(result.status).toBe("accepted");
      expect(result.actionStatus).toBe("succeeded");
      expect(result.delivery).toBe("failed");
      failNotification = false;
      yield* service.retryDelivery({ id: result.id, expectedVersion: result.version });
      yield* service.drain();
      yield* service.drain();
      expect(executions).toBe(1);
      expect(notifications).toBe(2);
      expect((yield* service.list())[0]?.delivery).toBe("sent");
      expect(
        (yield* service
          .update(threadId, { ...input, expectedVersion: 2, withdraw: false })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
    }).pipe(Effect.provide(Requests.layer.pipe(Layer.provide(effects))));
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "modification keeps the same request, requires another approval and allows withdrawal",
  () =>
    Effect.gen(function* () {
      const service = yield* Requests.AgentRequestService;
      const created = yield* service.create(threadId, {
        ...input,
        action: { kind: "agent", instruction: "Envoyer avec ton MCP" },
      });
      yield* service.respond({
        id: created.id,
        expectedVersion: 1,
        decision: "revise",
        text: "Change le destinataire",
      });
      yield* service.drain();
      const revised = yield* service.update(threadId, {
        ...input,
        question: "Valider le nouveau destinataire ?",
        expectedVersion: 2,
        withdraw: false,
      });
      expect(revised.status).toBe("pending");
      expect(revised.history).toHaveLength(2);
      expect(yield* service.list()).toHaveLength(1);
      expect(
        (yield* service
          .update(ThreadId.make("other"), { ...input, expectedVersion: 3, withdraw: true })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
      const withdrawn = yield* service.update(threadId, {
        ...input,
        expectedVersion: 3,
        withdraw: true,
      });
      expect(withdrawn.status).toBe("withdrawn");
      expect(
        (yield* service
          .respond({ id: created.id, expectedVersion: 4, decision: "accept", text: "" })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
    }).pipe(
      Effect.provide(
        Requests.layer.pipe(
          Layer.provide(
            Layer.succeed(RequestEffects.RequestEffects, {
              execute: () => Effect.die("must not execute"),
              notify: () => Effect.void,
            }),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect("text needs a written answer; refusal never executes the proposed action", () =>
  Effect.gen(function* () {
    const service = yield* Requests.AgentRequestService;
    yield* service.create(threadId, { ...input, kind: "text", action: null });
    expect(
      (yield* service
        .respond({ id: input.id, expectedVersion: 1, decision: "answer", text: " " })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid");
    yield* service.respond({
      id: input.id,
      expectedVersion: 1,
      decision: "answer",
      text: "La référence est A12",
    });
    yield* service.drain();
    expect((yield* service.list())[0]?.response).toBe("La référence est A12");
    yield* service.create(threadId, { ...input, id: "refused" });
    yield* service.respond({
      id: "refused",
      expectedVersion: 1,
      decision: "reject",
      text: "Utilise un brouillon",
    });
    yield* service.drain();
    expect((yield* service.list())[1]?.status).toBe("rejected");
  }).pipe(
    Effect.provide(
      Requests.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestEffects.RequestEffects, {
            execute: () => Effect.die("must not execute"),
            notify: () => Effect.void,
          }),
        ),
        Layer.provide(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect(
  "restart preserves pending work and never replays a command whose result is uncertain",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const effects = Layer.succeed(RequestEffects.RequestEffects, {
        execute: () => Effect.die("must not replay"),
        notify: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const service = yield* Requests.AgentRequestService;
        yield* service.create(threadId, input);
        const accepted = yield* service.respond({
          id: input.id,
          expectedVersion: 1,
          decision: "accept",
          text: "",
        });
        // Simulate the process stopping after the durable claim, before its result was saved.
        const payload = yield* encodeRequest({
          ...accepted,
          actionStatus: "running",
        });
        yield* sql`UPDATE agent_requests SET payload_json = ${payload} WHERE id = ${input.id}`;
      }).pipe(Effect.provide(Requests.layer.pipe(Layer.provide(effects))));
      yield* Effect.gen(function* () {
        const service = yield* Requests.AgentRequestService;
        yield* service.drain();
        const recovered = (yield* service.list())[0]!;
        expect(recovered.actionStatus).toBe("uncertain");
        expect(recovered.delivery).toBe("sent");
      }).pipe(Effect.provide(Requests.layer.pipe(Layer.provide(effects))));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "agent actions can report their result only after approval and only from their owner",
  () =>
    Effect.gen(function* () {
      const service = yield* Requests.AgentRequestService;
      yield* service.create(threadId, {
        ...input,
        action: { kind: "agent", instruction: "Envoyer le message" },
      });
      const completion = {
        id: input.id,
        expectedVersion: 1,
        succeeded: true,
        summary: "Message envoyé",
      };
      expect((yield* service.complete(threadId, completion).pipe(Effect.flip)).reason).toBe(
        "invalid",
      );
      yield* service.respond({ id: input.id, expectedVersion: 1, decision: "accept", text: "" });
      yield* service.drain();
      expect(
        (yield* service
          .complete(ThreadId.make("other"), { ...completion, expectedVersion: 2 })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
      const result = yield* service.complete(threadId, { ...completion, expectedVersion: 2 });
      expect(result.actionStatus).toBe("succeeded");
      expect(result.history.at(-1)?.text).toBe("Message envoyé");
    }).pipe(
      Effect.provide(
        Requests.layer.pipe(
          Layer.provide(
            Layer.succeed(RequestEffects.RequestEffects, {
              execute: () => Effect.die("must not execute"),
              notify: () => Effect.void,
            }),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect(
  "the background worker delivers a saved answer without another client or manual drain",
  () =>
    Effect.gen(function* () {
      const service = yield* Requests.AgentRequestService;
      yield* service.create(threadId, { ...input, kind: "text", action: null });
      const delivered = yield* service.subscribe().pipe(
        Stream.filter((requests) =>
          requests.some((request) => request.id === input.id && request.delivery === "sent"),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* service.respond({
        id: input.id,
        expectedVersion: 1,
        decision: "answer",
        text: "Réponse enregistrée",
      });
      yield* Fiber.join(delivered);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Requests.workerLayer.pipe(
          Layer.provideMerge(Requests.layer),
          Layer.provide(
            Layer.succeed(RequestEffects.RequestEffects, {
              execute: () => Effect.die("must not execute"),
              notify: () => Effect.void,
            }),
          ),
          Layer.provide(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect(
  "shows the autonomous author and Slack source on existing requests, preserving the proposal",
  () =>
    Effect.gen(function* () {
      const service = yield* Requests.AgentRequestService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.create(threadId, input);
      expect((yield* service.list())[0]?.autonomousAgent).toBeUndefined();
      const agent = JSON.stringify({ name: "Qualifieur", trigger: "unqualified" });
      yield* sql`INSERT INTO autonomous_agents (id, payload_json) VALUES ('qualifier', ${agent})`;
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id, agent_id, title, prompt, started_at, task_id) VALUES (${threadId}, 'qualifier', 'Test', '', '', 'task-source')`;
      const message = JSON.stringify({ channelName: "#studio-bleu" });
      yield* sql`INSERT INTO work_task_slack_messages (workspace_id, channel_id, message_ts, thread_ts, task_id, payload_json) VALUES ('W', 'C', '1', '1', 'task-source', ${message})`;
      const listed = (yield* service.list())[0]!;
      expect(listed.autonomousAgent).toEqual({
        name: "Qualifieur",
        qualifier: true,
        source: "Slack - #studio-bleu",
      });
      expect(listed.question).toBe(input.question);
      const revised = yield* service.update(threadId, {
        ...input,
        expectedVersion: 1,
        withdraw: false,
        qualification: { decision: "reject", source: "Gmail - xavier@studio-bleu.fr" },
      });
      expect(revised.qualification).toEqual({
        decision: "reject",
        source: "Gmail - xavier@studio-bleu.fr",
      });
      expect((yield* service.list())[0]?.qualification).toEqual(revised.qualification);
    }).pipe(
      Effect.provide(
        Requests.layer.pipe(
          Layer.provide(
            Layer.succeed(RequestEffects.RequestEffects, {
              execute: () => Effect.succeed(true),
              notify: () => Effect.void,
            }),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect(
  "ignoring archives text and approval requests without notifying or executing, even after restart",
  () =>
    Effect.gen(function* () {
      const effects = Layer.succeed(RequestEffects.RequestEffects, {
        execute: () => Effect.die("ignored requests must not execute"),
        notify: () => Effect.die("ignored requests must not notify"),
      });
      yield* Effect.gen(function* () {
        const service = yield* Requests.AgentRequestService;
        for (const proposal of [
          input,
          { ...input, id: "ignored-text", kind: "text" as const, action: null },
        ]) {
          const created = yield* service.create(threadId, proposal);
          const ignored = yield* service.respond({
            id: created.id,
            expectedVersion: created.version,
            decision: "ignore",
            text: "Unsent draft",
          });
          expect(ignored.status).toBe("ignored");
          expect(ignored.response).toBe("");
          expect(ignored.delivery).toBe("none");
          expect(ignored.actionStatus).toBe("idle");
          expect(
            (yield* service
              .retryDelivery({ id: ignored.id, expectedVersion: ignored.version })
              .pipe(Effect.flip)).reason,
          ).toBe("invalid");
        }
        yield* service.drain();
      }).pipe(Effect.provide(Requests.layer.pipe(Layer.provide(effects))));
      yield* Effect.gen(function* () {
        const service = yield* Requests.AgentRequestService;
        yield* service.drain();
        expect((yield* service.list()).map((request) => request.status)).toEqual([
          "ignored",
          "ignored",
        ]);
      }).pipe(Effect.provide(Requests.layer.pipe(Layer.provide(effects))));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
