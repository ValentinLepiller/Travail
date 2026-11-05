import * as Effect from "effect/Effect";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

/** Plugin requests use the selected environment's cookie, bearer or renewed relay session. */
export function executePluginMarketplaceRequest<A, E>(
  input: Omit<
    Parameters<typeof executeAuthenticatedEnvironmentHttpRequest<"plugins", A, E, never>>[0],
    "group" | "signer" | "remoteAuthorization" | "timeoutMs"
  >,
) {
  return Effect.gen(function* () {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "plugins",
      timeoutMs: 60_000,
      signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    });
  });
}
