import { executePluginMarketplaceRequest } from "@t3tools/client-runtime/state/plugin-marketplace";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginMarketplaceHarnessId,
  PluginMarketplaceSetupAction,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";

class PluginEnvironmentDisconnectedError extends Data.TaggedError(
  "PluginEnvironmentDisconnectedError",
) {
  override readonly message = "Connect to this environment to manage its plugins.";
}

export function createPluginMarketplaceApi(environmentId: EnvironmentId) {
  async function request<A, E>(
    input: Omit<Parameters<typeof executePluginMarketplaceRequest<A, E>>[0], "prepared">,
  ) {
    const command = createRuntimeCommand(connectionAtomRuntime, {
      label: "web:plugin-marketplace",
      execute: () =>
        Effect.gen(function* () {
          const prepared = yield* Effect.sync(() => readPreparedConnection(environmentId));
          if (prepared === null) return yield* new PluginEnvironmentDisconnectedError();
          return yield* executePluginMarketplaceRequest({ ...input, prepared });
        }),
    });
    const result = await command.run(appAtomRegistry, undefined);
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value;
  }

  return {
    fetchPluginMarketplaceCatalog: (query?: string) =>
      request({
        method: "GET",
        url: (urls) => urls.catalog(),
        request: ({ client, headers }) =>
          client.catalog({ headers, payload: query?.trim() ? { q: query } : {} }),
      }),
    fetchPluginMarketplaceDetail: (pluginId: string) =>
      request({
        method: "GET",
        url: (urls) => urls.detail({ params: { pluginId } }),
        request: ({ client, headers }) => client.detail({ headers, params: { pluginId } }),
      }),
    fetchPluginMarketplaceLogo: (pluginId: string) =>
      request({
        method: "GET",
        url: (urls) => urls.logo({ params: { pluginId } }),
        request: ({ client, headers }) => client.logo({ headers, params: { pluginId } }),
      }),
    fetchPluginMcpAuth: (pluginId: string) =>
      request({
        method: "GET",
        url: (urls) => urls.mcpAuth({ params: { pluginId } }),
        request: ({ client, headers }) => client.mcpAuth({ headers, params: { pluginId } }),
      }),
    startPluginMcpAuth: (pluginId: string, harness: PluginMarketplaceHarnessId, serverId: string) =>
      request({
        method: "POST",
        url: (urls) => urls.startMcpAuth({ params: { pluginId } }),
        request: ({ client, headers }) =>
          client.startMcpAuth({ headers, params: { pluginId }, payload: { harness, serverId } }),
      }),
    completePluginMcpAuth: (
      pluginId: string,
      harness: PluginMarketplaceHarnessId,
      serverId: string,
      callbackUrl: string,
    ) =>
      request({
        method: "POST",
        url: (urls) => urls.completeMcpAuth({ params: { pluginId } }),
        request: ({ client, headers }) =>
          client.completeMcpAuth({
            headers,
            params: { pluginId },
            payload: { harness, serverId, callbackUrl },
          }),
      }),
    disconnectPluginMcpAuth: (
      pluginId: string,
      harness: PluginMarketplaceHarnessId,
      serverId: string,
    ) =>
      request({
        method: "POST",
        url: (urls) => urls.disconnectMcpAuth({ params: { pluginId } }),
        request: ({ client, headers }) =>
          client.disconnectMcpAuth({
            headers,
            params: { pluginId },
            payload: { harness, serverId },
          }),
      }),
    installPlugin: (pluginId: string) =>
      request({
        method: "POST",
        url: (urls) => urls.install({ params: { pluginId } }),
        request: ({ client, headers }) => client.install({ headers, params: { pluginId } }),
      }),
    openPluginSetup: (pluginId: string, action: PluginMarketplaceSetupAction) =>
      request({
        method: "POST",
        url: (urls) => urls.setup({ params: { pluginId } }),
        request: ({ client, headers }) =>
          client.setup({ headers, params: { pluginId }, payload: { action } }),
      }),
    removePlugin: (pluginId: string) =>
      request({
        method: "POST",
        url: (urls) => urls.remove({ params: { pluginId } }),
        request: ({ client, headers }) => client.remove({ headers, params: { pluginId } }),
      }),
  };
}

export type PluginMarketplaceApi = ReturnType<typeof createPluginMarketplaceApi>;
