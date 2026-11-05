import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { ProviderInstanceEntry } from "../../providerInstances";

export function defaultRequestChatModel(
  entries: ReadonlyArray<
    Pick<ProviderInstanceEntry, "instanceId" | "driverKind" | "enabled" | "isAvailable">
  >,
): ModelSelection | null {
  const codex = entries.find(
    (entry) => entry.driverKind === "codex" && entry.enabled && entry.isAvailable,
  );
  return codex
    ? createModelSelection(codex.instanceId, "gpt-6.1-terra", [
        { id: "reasoningEffort", value: "medium" },
      ])
    : null;
}
