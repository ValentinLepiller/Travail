import { expect, it } from "@effect/vitest";
import {
  type AgentDesktopStatus,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as AgentDesktops from "../agentDesktops/AgentDesktops.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread:desktop-owner");
const idleThreadId = ThreadId.make("thread:desktop-idle");
const leaseId = "a1111111-1111-4111-8111-111111111111";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFoQAAAAASUVORK5CYII=",
  "base64",
);

const invocation = (id: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:desktop-test"),
  requestNamespace: `session:${id}`,
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: `session:${id}`,
  },
  client: undefined,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "desktop-toolkit-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "desktop-toolkit-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "returns a native desktop image owned by the calling thread and refuses outsider or idle writes",
  () => {
    const capturedOwners: string[] = [];
    const acquiredNamespaces: string[] = [];
    const status = (ownerId: string): AgentDesktopStatus => ({
      sessionId: "private-desktop-session",
      ownerId,
      display: ":190",
      width: 1280,
      height: 720,
      controller: "agent",
      revision: 1,
      applications: 1,
    });
    const layerDesktops = Layer.mock(AgentDesktops.AgentDesktops)({
      acquire: (namespace) =>
        Effect.sync(() => {
          acquiredNamespaces.push(namespace);
          return { leaseId, status: status(`${namespace}/${leaseId}`) };
        }),
      capture: (ownerId) =>
        Effect.sync(() => {
          capturedOwners.push(ownerId);
          return {
            status: status(ownerId),
            windows: [{ id: "window-1", title: "Private terminal" }],
            screenshot: {
              mimeType: "image/png" as const,
              data: png.toString("base64"),
              width: 1280,
              height: 720,
            },
          };
        }),
    });
    const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          McpToolAccessTestkit.liveThreadShell(
            id,
            id === idleThreadId ? { activeRunId: null } : {},
          ),
        ),
    });
    const layerTest = McpHttpServer.layerAgentDesktopToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(layerDesktops),
      Layer.provide(layerThreads),
    );

    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        scope: McpInvocationContext.McpInvocationScope,
        name: string,
        args: Record<string, unknown>,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const opened = yield* call(invocation(threadId), "agent_desktop_open", {});
      expect(opened.isError).toBe(false);
      expect(acquiredNamespaces).toEqual([threadId]);

      const shot = yield* call(invocation(threadId), "agent_desktop_capture", {
        leaseId,
        ownerId: "forged-owner",
        namespace: "forged-namespace",
        threadId: "forged-thread",
      });
      expect(shot.isError).toBe(false);
      expect(capturedOwners).toEqual([`${threadId}/${leaseId}`]);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.content.find((entry) => entry.type === "image")).toMatchObject({
        mimeType: "image/png",
        data: new Uint8Array(png),
      });
      const metadata = {
        status: status(`${threadId}/${leaseId}`),
        windows: [{ id: "window-1", title: "Private terminal" }],
        screenshot: { mimeType: "image/png", width: 1280, height: 720 },
      };
      expect(shot.structuredContent).toEqual(metadata);
      const text = shot.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" && JSON.parse(text.text)).toEqual(metadata);
      expect(JSON.stringify(shot.structuredContent)).not.toContain(png.toString("base64"));

      for (const access of ["full-access", "read-only"] as const) {
        const outsider: McpInvocationContext.McpInvocationScope = {
          ...invocation(threadId),
          thread: undefined,
          client: { sessionId: "oauth-session", label: "External client", access },
        };
        const deniedCapture = yield* call(outsider, "agent_desktop_capture", { leaseId });
        expect(deniedCapture.isError).toBe(true);
        expect(deniedCapture.content.map((entry) => entry.type)).toEqual(["text"]);
        const deniedOpen = yield* call(outsider, "agent_desktop_open", {});
        expect(deniedOpen.isError).toBe(true);
      }
      const idleOpen = yield* call(invocation(idleThreadId), "agent_desktop_open", {});
      expect(idleOpen.isError).toBe(true);
      expect(capturedOwners).toEqual([`${threadId}/${leaseId}`]);
      expect(acquiredNamespaces).toEqual([threadId]);
    }).pipe(Effect.scoped, Effect.provide(layerTest));
  },
);
