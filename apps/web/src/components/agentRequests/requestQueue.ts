import type { AgentRequest } from "@t3tools/contracts";

export function requestQueue<T extends Pick<AgentRequest, "id" | "status">>(
  requests: ReadonlyArray<T>,
  archived: boolean,
  selectedId: string | null,
) {
  const pending = requests.filter((request) => request.status === "pending");
  const visible = archived
    ? requests.filter((request) => request.status !== "pending").toReversed()
    : pending;
  return {
    pendingCount: pending.length,
    visible,
    current: visible.find((request) => request.id === selectedId) ?? visible[0],
  };
}
