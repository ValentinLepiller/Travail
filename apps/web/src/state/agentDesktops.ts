import type { EnvironmentId } from "@t3tools/contracts";
import {
  resolveDeviceHubAccess,
  type DeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";

const desktopAccess = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      return prepared === null
        ? Effect.never
        : resolveDeviceHubAccess({ prepared, hubBasePath: "/api/agent-desktops" });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`agent-desktop-access:${environmentId}`)),
);

export function readAgentDesktopAccess(
  environmentId: EnvironmentId,
  refresh = false,
): Promise<DeviceHubAccess | null> {
  const atom = desktopAccess(environmentId);
  if (refresh) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
