import * as ChantierCoordinator from "../../../workTasks/WorkChantierCoordinator.ts";
import * as Contexts from "../../../inbox/InboxContextService.ts";
import * as ContextSource from "../../../inbox/InboxContextSource.ts";
import * as Inbox from "../../../inbox/MessageInbox.ts";
import { taskImageTestLayer } from "../../../workTasks/WorkTaskService.testkit.ts";
import * as TaskAgents from "../../../workTasks/WorkTaskAgentService.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
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
  Layer.provideMerge(
    Contexts.layer.pipe(
      Layer.provide(Inbox.layer),
      Layer.provide(Sqlite.layerMemory),
      Layer.provide(
        Layer.succeed(ContextSource.InboxContextSource, {
          read: () =>
            Effect.succeed({ status: "ready", messages: [], truncated: false, reason: null }),
        }),
      ),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(Inbox.layer, Tasks.layer.pipe(Layer.provide(taskImageTestLayer))).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  ),
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
  Layer.provideMerge(collectorLayer),
  Layer.provide(Layer.mock(TaskAgents.WorkTaskAgentService)({})),
  Layer.provide(Layer.mock(ChantierCoordinator.WorkChantierCoordinator)({})),
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
    expect(
      yield* call("work_qualification_reserve", scope, {
        tasks: [{ id: "task", expectedVersion: 1 }],
      }).pipe(Effect.flip),
    ).toBeDefined();
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

it.effect.each(["unqualified", "todo"] as const)(
  "%s agents can read chantier context for a Slack clarification while chantier writes remain blocked",
  (trigger) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tasks = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:mcp-test");
      const caller = ThreadId.make(`caller-${trigger}`);
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/tmp/project','[]','now','now')`;
      const chantier = yield* tasks.saveChantier({
        id: "chantier",
        expectedVersion: 0,
        projectId,
        title: "Caisse",
        status: "active",
        objective: "Vente",
        scope: "Lot paiements",
        decisions: "",
        targetPeriod: "",
        sources: [],
        externalDependencies: [],
      });
      const target = yield* tasks.save({
        id: "payment-lot",
        expectedVersion: 0,
        title: "Lot paiements",
        notes: "Lot non terminé",
        status: "doing",
        projectId,
        agentThreadId: null,
        dueDate: null,
        chantierId: chantier.id,
      });
      const source = yield* tasks.save({
        id: "slack-clarification",
        expectedVersion: 0,
        title: "Précision sur les paiements",
        notes: "Un message Slack précise les cas à accepter du lot paiements.",
        sources: [
          { kind: "slack", label: "Précision client", url: "https://example.com/slack/message" },
        ],
        status: "ready",
        projectId,
        agentThreadId: null,
        dueDate: null,
      });
      yield* sql`INSERT INTO autonomous_agents (id,payload_json) VALUES ('worker', ${JSON.stringify({ trigger, projectId: null, currentThreadId: caller, paused: false })})`;
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id) VALUES (${caller},'worker','Clarification','','now',${source.id})`;
      const invocation: Invocation.McpInvocationScope = {
        ...scope,
        client: undefined,
        thread: {
          threadId: caller,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      };
      const call = (name: string, args: Record<string, unknown> = {}) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const list = yield* call("work_tasks_list");
      expect(list.isError).toBe(false);
      expect(list.structuredContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: source.id }),
          expect.objectContaining({ id: target.id }),
        ]),
      );
      const context = yield* call("work_chantier_read", { id: chantier.id });
      expect(context.isError).toBe(false);
      expect(context.structuredContent).toMatchObject({
        chantier: { id: chantier.id },
        tasks: [{ id: target.id, notes: target.notes }],
      });
      const read = yield* call("work_task_read", { id: target.id });
      expect(read.isError).toBe(false);
      expect(read.structuredContent).toMatchObject({ task: { id: target.id, status: "doing" } });
      const reservation = yield* call("work_qualification_reserve", {
        tasks: [{ id: source.id, expectedVersion: source.version }],
      }).pipe(Effect.flip);
      expect(reservation).toBeDefined();
      expect(
        (yield* call("work_chantier_apply_plan", {
          chantier: { ...chantier, expectedVersion: chantier.version },
          tasks: [{ ...target, title: "Changed", expectedVersion: target.version }],
        })).isError,
      ).toBe(true);
      expect(yield* tasks.read(target.id)).toEqual(target);
      expect(yield* tasks.readChantier(chantier.id)).toEqual(chantier);
      const saved = yield* tasks.save(
        {
          ...source,
          status: "review",
          expectedVersion: source.version,
        },
        caller,
      );
      expect(saved.sources).toEqual(source.sources);
      expect(saved.chantierId).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
