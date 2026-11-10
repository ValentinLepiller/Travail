import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const inboxQualificationProgress = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "inbox:qualification-progress",
    tag: WS_METHODS.inboxQualificationStatus,
    idleTtlMs: 0,
    staleTimeMs: 0,
    refreshIntervalMs: 10_000,
  },
);
export const inboxGroupingProgress = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "inbox:grouping-progress",
  tag: WS_METHODS.inboxGroupingStatus,
  idleTtlMs: 0,
  staleTimeMs: 0,
  refreshIntervalMs: 10_000,
});
