import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import * as Collector from "../../../workTasks/SlackTaskCollector.ts";
import * as Source from "../../../workTasks/SlackTaskSource.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { WorkTasksToolkit } from "./tools.ts";

const collectorLayer = Collector.layer.pipe(
  Layer.provideMerge(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
  Layer.provide(
    Layer.succeed(Source.SlackTaskSource, {
      readPage: () => Effect.die("Disabled collector must not access Slack"),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "slack-task-mcp-" })),
  Layer.provide(NodeServices.layer),
);
const layer = McpHttpServer.toolkitRegistration(WorkTasksToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(collectorLayer),
  Layer.provide(AccessTestkit.liveThreadsLayer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("slack-tasks-test"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "read-only" },
};

it.effect("allows status inspection but denies a read-only caller collection access", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, invocation = scope, args: Record<string, unknown> = {}) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect((yield* call("slack_tasks_status")).isError).toBe(false);
    expect((yield* call("work_tasks_list")).isError).toBe(false);
    for (const name of ["work_task_claim", "work_task_release"]) {
      expect((yield* call(name, scope, { id: "task", expectedVersion: 1 })).isError).toBe(true);
      expect(
        (yield* call(
          name,
          { ...scope, client: { ...scope.client!, access: "full-access" } },
          { id: "task", expectedVersion: 1 },
        )).isError,
      ).toBe(true);
    }
    expect((yield* call("slack_tasks_sync")).isError).toBe(true);
    const result = yield* call("slack_tasks_sync", {
      ...scope,
      client: { ...scope.client!, access: "full-access" },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ enabled: false, created: 0 });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
