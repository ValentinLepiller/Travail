import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";

const threadId = ThreadId.make("thread:mcp-maintenance");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-maintenance"),
  requestNamespace: "session:mcp-maintenance",
  thread: {
    threadId,
    providerSessionId: "session:mcp-maintenance",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-maintenance-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-maintenance-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "allows MCP cancellation during quiescence while refusing new messages and retaining permission checks",
  () => {
    const calls: string[] = [];
    const layerService = Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      cancelTask: (_, input) =>
        Effect.sync(() => {
          calls.push("cancel");
          return { taskId: input.taskId, status: "cancel_requested" as const };
        }),
      interruptThread: (_, input) =>
        Effect.sync(() => {
          calls.push("interrupt");
          return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
        }),
      sendToThread: () => Effect.die("New messages must not reach the service during maintenance"),
    });
    const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
      stopWorkflow: () =>
        Effect.sync(() => {
          calls.push("workflow-stop");
        }),
    });
    const layerTest = McpHttpServer.toolkitRegistration(
      OrchestratorToolkit,
      OrchestratorHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(layerService),
      Layer.provide(layerThreads),
      Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
      Layer.provideMerge(RuntimeAdmission.layer),
    );
    return Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
      yield* gate.quiesce("maintenance-mcp", () =>
        Effect.succeed({ activeWork: 0, activeVoice: 0, activeDesktops: 0 }),
      );
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      expect((yield* call("task_cancel", { taskId: "task:maintenance" })).isError).toBe(false);
      expect((yield* call("t3_thread_interrupt", { threadId })).isError).toBe(false);
      expect(
        (yield* call("t3_workflow_stop", { threadId, subagentId: "workflow:maintenance" })).isError,
      ).toBe(false);
      expect(calls).toEqual(["cancel", "interrupt", "workflow-stop"]);
      const refused = yield* call("t3_thread_send", { threadId, message: "New work" });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("maintenance_active");
      const readOnly: McpInvocationContext.McpInvocationScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "read-only", label: "Read only", access: "read-only" },
      };
      expect((yield* call("t3_thread_interrupt", { threadId }, readOnly)).isError).toBe(true);
      expect(calls).toEqual(["cancel", "interrupt", "workflow-stop"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest));
  },
);
