import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const autonomousAgents = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "autonomous:list",
  tag: WS_METHODS.autonomousAgentsSubscribe,
  idleTtlMs: 0,
});
export const autonomousAgentDetail = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  { label: "autonomous:detail", tag: WS_METHODS.autonomousAgentsRead, idleTtlMs: 0 },
);
export const commandAutonomousAgent = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "autonomous:command",
  tag: WS_METHODS.autonomousAgentsCommand,
});
