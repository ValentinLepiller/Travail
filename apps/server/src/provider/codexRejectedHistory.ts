import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";

/** A bare backend rejection provides no repairable field; resume must replace the history. */
export function codexRejectedHistory(items: ReadonlyArray<OrchestrationV2TurnItem>, runId: RunId) {
  return items.some((item) => {
    if (item.runId !== runId || item.type !== "error" || item.failure.class !== "provider_error") {
      return false;
    }
    try {
      const error: unknown = JSON.parse(item.failure.message);
      return (
        typeof error === "object" &&
        error !== null &&
        "detail" in error &&
        error.detail === "Bad Request"
      );
    } catch {
      return false;
    }
  });
}
