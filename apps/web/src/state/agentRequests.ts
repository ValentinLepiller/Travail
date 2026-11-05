import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const agentRequests = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "requests:list",
  tag: WS_METHODS.agentRequestsSubscribe,
  idleTtlMs: 0,
});
export const respondToRequest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "requests:respond",
  tag: WS_METHODS.agentRequestsRespond,
});
export const retryRequestDelivery = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "requests:retry-delivery",
  tag: WS_METHODS.agentRequestsRetryDelivery,
});
export const requestChat = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "requests:chat",
  tag: WS_METHODS.agentRequestChatSubscribe,
  idleTtlMs: 0,
});
export const sendRequestChat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "requests:chat:send",
  tag: WS_METHODS.agentRequestChatSend,
});
export const stopRequestChat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "requests:chat:stop",
  tag: WS_METHODS.agentRequestChatStop,
});
export const clearRequestChat = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "requests:chat:clear",
  tag: WS_METHODS.agentRequestChatClear,
});
