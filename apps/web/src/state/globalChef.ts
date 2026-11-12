import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

const refresh = { idleTtlMs: 0, staleTimeMs: 0, refreshIntervalMs: 10_000 };
export const globalChefStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  ...refresh,
  label: "chef:status",
  tag: WS_METHODS.globalChefStatus,
});
export const globalChefDossiers = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  ...refresh,
  label: "chef:dossiers",
  tag: WS_METHODS.globalChefList,
});
export const globalChefDossier = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  ...refresh,
  label: "chef:dossier",
  tag: WS_METHODS.globalChefRead,
});
export const globalChefMemory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  ...refresh,
  label: "chef:memory",
  tag: WS_METHODS.globalChefMemory,
});
export const commandGlobalChef = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "chef:command",
  tag: WS_METHODS.globalChefCommand,
});
