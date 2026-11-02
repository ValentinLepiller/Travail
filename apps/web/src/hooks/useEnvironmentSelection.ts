import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

/** Select an existing connection even when the client has no same-origin backend. */
export function useEnvironmentSelection() {
  const catalog = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [selectedId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const environment =
    catalog.environments.find((entry) => entry.environmentId === selectedId) ??
    catalog.environments.find((entry) => entry.environmentId === primaryId) ??
    catalog.environments.find((entry) => entry.connection.phase === "connected") ??
    catalog.environments[0];

  return { ...catalog, environmentId: environment?.environmentId ?? null, setEnvironmentId };
}
