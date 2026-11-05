import { expect, it } from "@effect/vitest";
import {
  AgentRequest,
  AgentRequestChat,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  TextGenerationError,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Chat from "./AgentRequestChatService.ts";

const threadId = ThreadId.make("source");
const runId = RunId.make("source-run");
const projectId = ProjectId.make("project");
const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-terra",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(AgentRequest));
const encodeChat = Schema.encodeEffect(Schema.fromJsonString(AgentRequestChat));
const dataLayer = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const chatLayer = (
  generateChatReply: TextGeneration.TextGeneration["Service"]["generateChatReply"],
) =>
  Chat.layer.pipe(Layer.provide(Layer.mock(TextGeneration.TextGeneration)({ generateChatReply })));
const read = (chat: Chat.AgentRequestChatService["Service"], id = "request") =>
  chat.subscribe(id).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
const finished = (chat: Chat.AgentRequestChatService["Service"], id = "request") =>
  chat.subscribe(id).pipe(
    Stream.filter((value) => value.activeMessageId === null),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
const send = (
  chat: Chat.AgentRequestChatService["Service"],
  messageId = "question",
  id = "request",
) => chat.send({ id, messageId, text: "Explique-moi le blocage", modelSelection: selection });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const at = yield* DateTime.now;
  const iso = DateTime.formatIso(at);
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: iso,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Projet test",
      workspaceRoot: "/tmp",
      defaultModelSelection: selection,
      scripts: [],
      createdAt: iso,
      updatedAt: iso,
    },
  });
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: "Discussion source",
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* projections.apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: thread,
  });
  yield* projections.apply({
    id: EventId.make("run-created"),
    type: "run.updated",
    threadId,
    runId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: selection.instanceId,
      modelSelection: selection,
      providerThreadId: null,
      userMessageId: MessageId.make("source-message"),
      rootNodeId: NodeId.make("root"),
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  for (let i = 0; i < 130; i++) {
    yield* projections.apply({
      id: EventId.make(`item-event:${i}`),
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(`item:${i}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: i,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "assistant_message",
        messageId: MessageId.make(`message:${i}`),
        text: `Contexte ancien ${i}`,
        streaming: false,
      },
    });
  }
  const base = yield* projections.getTurnItem({ threadId, itemId: TurnItemId.make("item:129") });
  if (!base || base.type !== "assistant_message") return yield* Effect.die("Missing test message");
  yield* projections.apply({
    id: EventId.make("large-tool-output"),
    type: "turn-item.updated",
    threadId,
    runId,
    occurredAt: at,
    payload: {
      ...base,
      id: TurnItemId.make("large-tool-output"),
      ordinal: 130,
      type: "command_execution",
      input: "read large response",
      output: "TOOL_OUTPUT_NOT_CONVERSATION".repeat(100_000),
    },
  });
  yield* projections.apply({
    id: EventId.make("source-plan"),
    type: "turn-item.updated",
    threadId,
    runId,
    occurredAt: at,
    payload: {
      ...base,
      id: TurnItemId.make("source-plan"),
      ordinal: 131,
      type: "proposed_plan",
      planId: PlanId.make("source-plan"),
      markdown: "Plan complet à conserver",
      streaming: false,
    },
  });
  const request: AgentRequest = {
    id: "request",
    threadId,
    context: "Il manque une référence",
    question: "Quelle offre utiliser ?",
    details: "Détails indispensables",
    kind: "approval",
    action: { kind: "agent", instruction: "Action à ne pas exécuter" },
    version: 3,
    status: "pending",
    response: "",
    history: [{ at: iso, text: "Ancienne version de la requête" }],
    actionStatus: "idle",
    delivery: "none",
    createdAt: iso,
    updatedAt: iso,
  };
  yield* sql`INSERT INTO agent_requests (id, payload_json) VALUES (${request.id}, ${yield* encodeRequest(request)})`;
  return { request, thread, at };
});

it.effect(
  "answers with all inherited history and request revisions, without answering or changing the source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request, thread, at } = yield* seed;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const forkId = ThreadId.make("fork");
        yield* projections.apply({
          id: EventId.make("fork-created"),
          type: "thread.created",
          threadId: forkId,
          occurredAt: at,
          payload: {
            ...thread,
            id: forkId,
            title: "Discussion dérivée",
            lineage: {
              parentThreadId: threadId,
              relationshipToParent: "fork",
              rootThreadId: threadId,
            },
            forkedFrom: { type: "run", threadId, runId },
          },
        });
        yield* sql`UPDATE agent_requests SET payload_json = ${yield* encodeRequest({ ...request, threadId: forkId })} WHERE id = 'request'`;
        let calls = 0;
        yield* Effect.gen(function* () {
          const chat = yield* Chat.AgentRequestChatService;
          yield* send(chat);
          const result = yield* finished(chat);
          expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
          expect(result.sourceVersion).toBe(3);
          expect(result.modelSelection).toEqual(selection);
          yield* send(chat);
          expect(calls).toBe(1);
          const unchanged = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM agent_requests WHERE id = 'request'`;
          expect(unchanged[0]?.payload_json).toBe(
            yield* encodeRequest({ ...request, threadId: forkId }),
          );
          expect((yield* projections.getThreadProjection(forkId)).runs).toHaveLength(0);
          yield* chat.clear("request");
          expect((yield* read(chat)).messages).toEqual([]);
        }).pipe(
          Effect.provide(
            chatLayer((input) =>
              Effect.sync(() => {
                calls++;
                expect(input.prompt).toContain("Contexte ancien 0");
                expect(input.prompt).toContain("Contexte ancien 129");
                expect(input.prompt).toContain("Plan complet à conserver");
                expect(input.prompt).not.toContain("TOOL_OUTPUT_NOT_CONVERSATION");
                expect(input.prompt.length).toBeLessThan(20_000);
                expect(input.prompt).toContain("Ancienne version de la requête");
                expect(input.prompt).toContain("Détails indispensables");
                expect(input.modelSelection).toEqual(selection);
                return { text: "Il manque la référence de l’offre." };
              }),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(dataLayer)),
);

it.effect("keeps chats separate, refuses concurrent questions and stops an active answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { request } = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agent_requests (id, payload_json) VALUES ('other', ${yield* encodeRequest({ ...request, id: "other" })})`;
      const entered = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const chat = yield* Chat.AgentRequestChatService;
        yield* send(chat);
        yield* Deferred.await(entered);
        expect((yield* send(chat, "second").pipe(Effect.flip)).reason).toBe("busy");
        expect((yield* chat.clear("request").pipe(Effect.flip)).reason).toBe("busy");
        expect((yield* read(chat, "other")).messages).toHaveLength(0);
        yield* chat.stop("request");
        const result = yield* finished(chat);
        expect(result.messages).toHaveLength(1);
        expect(result.error).toContain("interrompue");
        yield* chat.clear("request");
        expect((yield* read(chat)).messages).toHaveLength(0);
      }).pipe(
        Effect.provide(
          chatLayer(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
        ),
      );
    }),
  ).pipe(Effect.provide(dataLayer)),
);

it.effect(
  "retains conversation after reopening, refreshes the request and carries previous replies when switching models",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { request } = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        let calls = 0;
        const generator = chatLayer((input) =>
          Effect.sync(() => {
            if (++calls === 2) {
              expect(input.prompt).toContain("Première réponse conservée");
              expect(input.prompt).toContain("Nouvelle question de la requête");
              expect(input.modelSelection.model).toBe("another-model");
            }
            return { text: "Première réponse conservée" };
          }),
        );
        yield* Effect.gen(function* () {
          const chat = yield* Chat.AgentRequestChatService;
          yield* send(chat);
          yield* finished(chat);
        }).pipe(Effect.provide(generator));
        yield* sql`UPDATE agent_requests SET payload_json = ${yield* encodeRequest({ ...request, version: 4, question: "Nouvelle question de la requête" })} WHERE id = 'request'`;
        yield* Effect.gen(function* () {
          const chat = yield* Chat.AgentRequestChatService;
          expect((yield* read(chat)).messages).toHaveLength(2);
          yield* chat.send({
            id: "request",
            messageId: "new-question",
            text: "Et maintenant ?",
            modelSelection: { ...selection, model: "another-model" },
          });
          const result = yield* finished(chat);
          expect(result.sourceVersion).toBe(4);
          expect(result.messages).toHaveLength(4);
          expect(result.error).toBeNull();
        }).pipe(Effect.provide(generator));
      }),
    ).pipe(Effect.provide(dataLayer)),
);

it.effect(
  "recovers interrupted persisted replies and records a model failure without a false answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const interrupted: AgentRequestChat = {
          messages: [
            {
              id: "old",
              role: "user",
              text: "Question en cours",
              createdAt: "2026-11-04T00:00:00Z",
            },
          ],
          modelSelection: selection,
          activeMessageId: "old",
          sourceVersion: 3,
          error: null,
        };
        yield* sql`INSERT INTO agent_request_chats (request_id, payload_json) VALUES ('request', ${yield* encodeChat(interrupted)})`;
        yield* Effect.gen(function* () {
          const chat = yield* Chat.AgentRequestChatService;
          const recovered = yield* read(chat);
          expect(recovered.activeMessageId).toBeNull();
          expect(recovered.error).toContain("redémarrage");
          yield* send(chat, "new");
          const result = yield* finished(chat);
          expect(result.messages.every((message) => message.role === "user")).toBe(true);
          expect(result.error).toContain("n’a pas pu répondre");
          expect((yield* send(chat, "missing", "absent").pipe(Effect.flip)).reason).toBe("missing");
        }).pipe(
          Effect.provide(
            chatLayer(() =>
              Effect.fail(
                new TextGenerationError({ operation: "generateChatReply", detail: "test failure" }),
              ),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(dataLayer)),
);
