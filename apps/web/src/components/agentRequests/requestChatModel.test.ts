import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { defaultRequestChatModel } from "./requestChatModel";

const codex = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
  isAvailable: true,
};
describe("temporary request chat model", () => {
  it("starts with Terra Medium on the environment’s enabled Codex instance", () => {
    expect(defaultRequestChatModel([codex])).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6.1-terra",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });
  it("does not silently use a disabled or unavailable provider", () => {
    expect(defaultRequestChatModel([{ ...codex, enabled: false }])).toBeNull();
    expect(defaultRequestChatModel([{ ...codex, isAvailable: false }])).toBeNull();
    expect(defaultRequestChatModel([])).toBeNull();
  });
});
