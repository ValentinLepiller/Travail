import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as Requests from "../../../agentRequests/AgentRequestService.ts";
import * as RequestEffects from "../../../agentRequests/RequestEffects.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { RequestsToolkit } from "./tools.ts";

const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("requests-environment"),
  requestNamespace: "requests-test",
  thread: {
    threadId: ThreadId.make("requests-thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session",
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "requests-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "requests-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const requestLayer = Requests.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(
    Layer.succeed(RequestEffects.RequestEffects, {
      execute: () => Effect.die("approval required"),
      notify: () => Effect.void,
    }),
  ),
);
const layer = McpHttpServer.toolkitRegistration(RequestsToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(requestLayer),
  Layer.provide(AccessTestkit.liveThreadsLayer),
);
it.effect(
  "MCP creates an owned request without waiting and isolates other threads and read-only clients",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const input = {
        id: "mcp-request",
        context:
          "La page Requêtes de Travail vient d’être modifiée. Son comportement dans le navigateur reste à vérifier.",
        question: "Autorises-tu un test dans le navigateur intégré sur les données isolées ?",
        details: "![Capture](https://example.com/image.png)",
        kind: "approval",
        action: null,
        source: {
          kind: "other",
          label: "Exemple",
          url: "https://example.com/message/42",
          text: "Le message d’origine",
        },
      };
      expect((yield* call("request_create", input)).isError).toBe(false);
      const service = yield* Requests.AgentRequestService;
      expect((yield* service.list())[0]?.threadId).toBe(scope.thread?.threadId);
      expect((yield* service.list())[0]?.source).toEqual(input.source);
      expect((yield* service.list())[0]).toMatchObject({
        context: input.context,
        question: input.question,
        details: input.details,
      });
      const other = {
        ...scope,
        thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
      };
      const hidden = yield* call("request_list", {}, other);
      expect(hidden.structuredContent).toEqual([]);
      expect(
        (yield* call("request_update", { ...input, expectedVersion: 1, withdraw: true }, other))
          .isError,
      ).toBe(true);
      const readOnly: Invocation.McpInvocationScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "read-only", label: "Read only", access: "read-only" },
      };
      expect((yield* call("request_create", { ...input, id: "denied" }, readOnly)).isError).toBe(
        true,
      );
      expect(yield* service.list()).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
