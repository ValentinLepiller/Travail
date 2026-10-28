import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
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
export const deleteWorkTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "work-tasks:delete",
  tag: WS_METHODS.workTasksDelete,
});
