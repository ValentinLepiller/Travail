import * as GlobalChef from "../../../globalChef/GlobalChefService.ts";
import * as ChefRuntime from "../../../globalChef/ChefRuntime.ts";
import * as ChefActions from "../../../inbox/InboxSubjectActions.ts";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import * as Requests from "../../../agentRequests/AgentRequestService.ts";
import * as RequestEffects from "../../../agentRequests/RequestEffects.ts";
import * as Subjects from "../../../inbox/InboxSubjectService.ts";
import * as SubjectModel from "../../../inbox/InboxSubjectModel.ts";
import * as Qualifications from "../../../inbox/InboxQualificationService.ts";
import * as Jev from "../../../inbox/JevClient.ts";
import * as AccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Contexts from "../../../inbox/InboxContextService.ts";
import * as ContextSource from "../../../inbox/InboxContextSource.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Inbox from "../../../inbox/MessageInbox.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { InboxToolkit } from "./tools.ts";

const layer = McpHttpServer.toolkitRegistration(InboxToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      GlobalChef.layer.pipe(
        Layer.provide(ChefActions.layer.pipe(Layer.provide(Tasks.layer))),
        Layer.provide(Tasks.layer),
        Layer.provide(
          Requests.layer.pipe(
            Layer.provide(
              Layer.succeed(RequestEffects.RequestEffects, {
                execute: () => Effect.die("No command in a read-only Chef test"),
                notify: () => Effect.die("No notification in a read-only Chef test"),
              }),
            ),
          ),
        ),
        Layer.provide(
          Layer.succeed(ChefRuntime.ChefRuntime, {
            inspect: () =>
              Effect.succeed({ status: "ready", checkedAt: "now", text: "[]", truncated: false }),
            generate: () => Effect.die("Read-only tools must not call a model"),
            ensureDossier: () => Effect.die("Read-only tools must not create a thread"),
            conversation: () => Effect.die("No conversation source was requested"),
            notify: () => Effect.die("Read-only tools must not notify a Chef"),
          }),
        ),
      ),
      Qualifications.layer.pipe(
        Layer.provide(
          Layer.succeed(Jev.JevClient, {
            evaluate: () => Effect.die("No qualification requested"),
          }),
        ),
      ),
      Subjects.layer.pipe(
        Layer.provide(
          Layer.succeed(SubjectModel.InboxSubjectModel, {
            generate: () => Effect.die("No grouping requested"),
          }),
        ),
      ),
      Inbox.layer,
      Contexts.layer.pipe(Layer.provide(Inbox.layer)),
    ).pipe(Layer.provide(Sqlite.layerMemory)),
  ),
  Layer.provide(
    Layer.mock(ContextSource.InboxContextSource)({
      read: () => Effect.succeed({ status: "ready", messages: [], truncated: false, reason: null }),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "inbox-context-mcp-" })),
  Layer.provide(NodeServices.layer),
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
  environmentId: EnvironmentId.make("inbox-test"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  thread: undefined,
  client: { sessionId: "test", label: "test", access: "read-only" },
};

it.effect(
  "lets a read-only native caller browse and read the persisted inbox with bounded pages",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox;
      const server = yield* McpServer.McpServer;
      const call = (name: string, args: Record<string, unknown> = {}) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const message = {
        workspaceId: "TTEST",
        channelId: "CTEST",
        channelName: "projet",
        authorId: "UCLIENT",
        ts: "1793278000.000001",
        threadTs: "1793278000.000001",
        text: "Message original",
      };
      yield* inbox.ingestSlack(message);
      yield* inbox.ingestSlack({ ...message, ts: "1793278001.000001" });
      expect((yield* call("chef_status")).structuredContent).toMatchObject({
        settings: { enabled: false },
        pending: 0,
        errors: 0,
      });
      expect((yield* call("chef_dossiers", { limit: 5 })).structuredContent).toEqual({
        dossiers: [],
        nextCursor: null,
      });
      expect((yield* call("chef_memory", { limit: 5 })).structuredContent).toEqual({
        memories: [],
        nextCursor: null,
      });
      expect(
        (yield* call("chef_control", { enabled: false, projectId: null, modelSelection: null }))
          .isError,
      ).toBe(true);
      expect((yield* call("inbox_context_backfill", {})).isError).toBe(true);
      expect((yield* call("inbox_qualification_control", { enabled: true })).isError).toBe(true);
      expect((yield* call("inbox_qualification_status")).structuredContent).toMatchObject({
        enabled: false,
        remaining: 2,
      });
      expect((yield* call("inbox_grouping_control", { enabled: true })).isError).toBe(true);
      expect((yield* call("inbox_grouping_status")).structuredContent).toMatchObject({
        enabled: false,
        processed: 0,
        waitingJev: 2,
      });
      expect((yield* call("inbox_subjects", { limit: 5 })).structuredContent).toMatchObject({
        subjects: [],
        nextCursor: null,
      });
      expect(
        (yield* call("inbox_subject_entries", { subjectId: "absent", limit: 5 })).structuredContent,
      ).toMatchObject({ messages: [], nextCursor: null });
      const first = yield* call("inbox_list", { limit: 1 });
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        messages: [{ source: { kind: "slack", message } }],
        nextCursor: 1,
      });
      expect((yield* call("inbox_list", { after: 1 })).structuredContent).toMatchObject({
        nextCursor: null,
      });
      expect(
        (yield* call("inbox_read", { id: "slack:TTEST:CTEST:1793278000.000001" }))
          .structuredContent,
      ).toMatchObject({ source: { kind: "slack", message } });
      expect((yield* call("inbox_read", { id: "missing" })).isError).toBe(true);
      expect((yield* call("inbox_list", { limit: 21 }).pipe(Effect.flip))._tag).toBe(
        "InvalidParams",
      );
      expect((yield* inbox.list({})).messages).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
