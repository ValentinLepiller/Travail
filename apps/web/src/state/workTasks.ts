import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const workTasks = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "work-tasks:list",
  tag: WS_METHODS.workTasksSubscribe,
  idleTtlMs: 0,
});
export const saveWorkTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-tasks:save",
  tag: WS_METHODS.workTasksSave,
});
export const workTaskMessages = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "work-tasks:messages",
  tag: WS_METHODS.workTasksMessages,
  idleTtlMs: 0,
});
export const deleteWorkTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-tasks:delete",
  tag: WS_METHODS.workTasksDelete,
});

export const workTaskTypes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "work-tasks:types",
  tag: WS_METHODS.workTasksTypes,
  idleTtlMs: 0,
});
export const saveWorkTaskTypes = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-tasks:save-types",
  tag: WS_METHODS.workTasksSaveTypes,
});
export const launchWorkTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-tasks:launch",
  tag: WS_METHODS.workTasksLaunch,
});

export const slackTaskFilters = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "work-tasks:slack-filters",
  tag: WS_METHODS.slackTaskFilters,
  idleTtlMs: 0,
  staleTimeMs: 0,
  refreshIntervalMs: 60_000,
});

export const workChantiers = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "work-chantiers:list",
  tag: WS_METHODS.workChantiersSubscribe,
  idleTtlMs: 0,
});
export const saveWorkChantier = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-chantiers:save",
  tag: WS_METHODS.workChantiersSave,
});
export const launchWorkChantier = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-chantiers:launch",
  tag: WS_METHODS.workChantiersLaunch,
});
