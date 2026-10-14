import {
  AgentDesktopLease,
  AgentDesktopSnapshot,
  AgentDesktopStatus,
  type AgentDesktopHumanAction,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  withDeviceHubQuery,
  type DeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Schema from "effect/Schema";

import { readAgentDesktopAccess } from "~/state/agentDesktops";

const decodeLeases = Schema.decodeUnknownPromise(Schema.Array(AgentDesktopLease));
const decodeSnapshot = Schema.decodeUnknownPromise(AgentDesktopSnapshot);
const decodeStatus = Schema.decodeUnknownPromise(AgentDesktopStatus);

/** Uses the destination environment's cookie or renewable ticket; never the primary URL implicitly. */
export function makeAgentDesktopClient(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dependencies = {
    readAccess: readAgentDesktopAccess,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  },
) {
  const { readAccess, fetch: fetchRequest } = dependencies;
  const request = async (path: string, init?: RequestInit) => {
    for (const fresh of [false, true]) {
      const access = await readAccess(environmentId, fresh);
      if (!access) throw new Error("La connexion au bureau de cet environnement est indisponible.");
      const response = await fetchRequest(agentDesktopUrl(access, threadId, path), {
        ...init,
        cache: "no-store",
        credentials: access.credentials ? "include" : "omit",
        signal: init?.signal ?? AbortSignal.timeout(15_000),
      });
      if (response.status === 401 && !fresh) continue;
      if (!response.ok)
        throw new Error(
          response.status === 423
            ? "Maintenance en cours. Réessayez après sa fin."
            : response.status === 403
              ? "Cet accès ne permet pas de contrôler le bureau."
              : "Le bureau est indisponible ou son contrôle a changé.",
        );
      return response;
    }
    throw new Error("La connexion au bureau doit être rétablie.");
  };
  return {
    list: async () => decodeLeases(await (await request("")).json()),
    capture: async (leaseId: string) =>
      decodeSnapshot(await (await request(`/${encodeURIComponent(leaseId)}?capture=1`)).json()),
    act: async (leaseId: string, action: AgentDesktopHumanAction) => {
      const response = await request(`/${encodeURIComponent(leaseId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      return response.status === 204 ? undefined : decodeStatus(await response.json());
    },
  };
}

function agentDesktopUrl(access: DeviceHubAccess, threadId: ThreadId, path: string) {
  return withDeviceHubQuery(`${access.httpBase}/${encodeURIComponent(threadId)}${path}`, access);
}
