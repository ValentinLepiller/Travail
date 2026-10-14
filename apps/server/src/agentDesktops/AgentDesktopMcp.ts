import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentDesktops from "./AgentDesktops.ts";
import {
  AgentDesktopApplication,
  AgentDesktopLeaseId,
  AgentDesktopError,
  AgentDesktopInput,
  AgentDesktopSnapshot,
  AgentDesktopStatus,
  AgentDesktopTarget,
} from "@t3tools/contracts";

const LeaseId = AgentDesktopLeaseId;
const lease = { leaseId: LeaseId };
const target = { ...lease, ...AgentDesktopTarget.fields };
const failure = Schema.Union([AgentDesktopError, OrchestratorMcpFailure]);
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AgentDesktops.AgentDesktops,
];

const LaunchInput = Schema.Struct({
  ...target,
  application: AgentDesktopApplication,
  message: Schema.optional(Schema.String),
});

export const AgentDesktopToolkit = Toolkit.make(
  Tool.make("agent_desktop_open", {
    description:
      "Acquire a private X11 desktop lease. Omit leaseId for a NEW independent desktop; retain the returned leaseId on EVERY later call. Native subagents sharing one MCP token must each acquire their own lease. Pass an existing leaseId to resume its desktop/profile. Never controls the personal desktop.",
    parameters: Schema.Struct({ leaseId: Schema.optional(LeaseId) }),
    success: Schema.Struct({ ...lease, status: AgentDesktopStatus }),
    failure,
    dependencies,
  }),
  Tool.make("agent_desktop_status", {
    description: "Inspect your private desktop lease and current control revision.",
    parameters: Schema.Struct(lease),
    success: AgentDesktopStatus,
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("agent_desktop_capture", {
    description:
      "Capture your private desktop as a PNG with visible window ids. Inspect before sending input. Empty desktops have no windows until you launch an application.",
    parameters: Schema.Struct(lease),
    success: AgentDesktopSnapshot,
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("agent_desktop_launch", {
    description:
      "Launch a separate native terminal or test message window in your lease. Terminal HOME/XDG/D-Bus/display are private. Requires current sessionId and revision; refuses while a human controls the desktop. Browser work uses MT preview tools separately.",
    parameters: LaunchInput,
    success: AgentDesktopStatus,
    failure,
    dependencies,
  }).annotate(Tool.OpenWorld, true),
  Tool.make("agent_desktop_input", {
    description:
      "Click screen coordinates, type text, or press an X11 key in a visible window of YOUR lease. Carry sessionId/revision from its latest capture. Human control blocks agent input. Actions can affect applications and shared files.",
    parameters: Schema.Struct({ ...lease, input: AgentDesktopInput }),
    success: AgentDesktopStatus,
    failure,
    dependencies,
  })
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true),
  Tool.make("agent_desktop_yield", {
    description:
      "Explicitly yield your lease to the human viewer, blocking further agent input/launch/close until the human releases control. Agents cannot reclaim human control themselves.",
    parameters: Schema.Struct(target),
    success: AgentDesktopStatus,
    failure,
    dependencies,
  }),
  Tool.make("agent_desktop_close", {
    description:
      "Close your private desktop and its tracked processes; preserve the profile for resume with the same leaseId. Refuses while a human controls it.",
    parameters: Schema.Struct(target),
    success: Schema.Void,
    failure,
    dependencies,
  }),
);

const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const thread = yield* McpInvocationContext.requireThreadScope(scope, "Agent desktops");
  const desktops = yield* AgentDesktops.AgentDesktops;
  return { namespace: thread.thread.threadId, desktops };
});

const handlers = {
  agent_desktop_open: McpToolAccess.actsAsCaller((params: { leaseId?: string | undefined }) =>
    caller.pipe(
      Effect.flatMap(({ namespace, desktops }) => desktops.acquire(namespace, params.leaseId)),
    ),
  ),
  agent_desktop_status: McpToolAccess.readsAsCaller((params: { leaseId: string }) =>
    caller.pipe(
      Effect.flatMap(({ namespace, desktops }) =>
        desktops.status(`${namespace}/${params.leaseId}`),
      ),
    ),
  ),
  agent_desktop_capture: McpToolAccess.readsAsCaller((params: { leaseId: string }) =>
    caller.pipe(
      Effect.flatMap(({ namespace, desktops }) =>
        desktops.capture(`${namespace}/${params.leaseId}`),
      ),
    ),
  ),
  agent_desktop_launch: McpToolAccess.actsAsCaller((params: typeof LaunchInput.Type) =>
    caller.pipe(
      Effect.flatMap(({ namespace, desktops }) =>
        desktops.launch(
          `${namespace}/${params.leaseId}`,
          params.application,
          params,
          params.message,
        ),
      ),
    ),
  ),
  agent_desktop_input: McpToolAccess.actsAsCaller(
    (params: { leaseId: string; input: AgentDesktopInput }) =>
      caller.pipe(
        Effect.flatMap(({ namespace, desktops }) =>
          desktops.input(`${namespace}/${params.leaseId}`, "agent", params.input),
        ),
      ),
  ),
  agent_desktop_yield: McpToolAccess.actsAsCaller(
    (params: { leaseId: string } & AgentDesktopTarget) =>
      caller.pipe(
        Effect.flatMap(({ namespace, desktops }) =>
          desktops.transfer(`${namespace}/${params.leaseId}`, params, "human"),
        ),
      ),
  ),
  agent_desktop_close: McpToolAccess.actsAsCaller(
    (params: { leaseId: string } & AgentDesktopTarget) =>
      caller.pipe(
        Effect.flatMap(({ namespace, desktops }) =>
          desktops.close(`${namespace}/${params.leaseId}`, "agent", params),
        ),
      ),
  ),
} satisfies McpToolAccess.Handlers<typeof AgentDesktopToolkit.tools>;

export const layer = McpToolAccess.toLayer(AgentDesktopToolkit, handlers);

export const AgentDesktopCaptureToolkit = Toolkit.make(
  AgentDesktopToolkit.tools.agent_desktop_capture,
);
export const AgentDesktopStandardToolkit = Toolkit.make(
  AgentDesktopToolkit.tools.agent_desktop_open,
  AgentDesktopToolkit.tools.agent_desktop_status,
  AgentDesktopToolkit.tools.agent_desktop_launch,
  AgentDesktopToolkit.tools.agent_desktop_input,
  AgentDesktopToolkit.tools.agent_desktop_yield,
  AgentDesktopToolkit.tools.agent_desktop_close,
);
const { agent_desktop_capture, ...standardHandlers } = handlers;
export const layerStandard = McpToolAccess.toLayer(AgentDesktopStandardToolkit, standardHandlers);
export const layerCapture = McpToolAccess.toLayer(AgentDesktopCaptureToolkit, {
  agent_desktop_capture,
});
