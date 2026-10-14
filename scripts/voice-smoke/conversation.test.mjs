import { expect, it } from "vitest";
import { assessConversation } from "./conversation.mjs";
const pcm = { windowNonDtxPackets: 10, windowPeak: 1000, windowRms: 100 };
const evidence = {
  callbackCount: 1,
  resolvedAtMs: 1000,
  ack: { turnId: "a", verifiedAtMs: 100, backendPendingAtVerification: true, pcm },
  exchange: {
    turnId: "b",
    verifiedAtMs: 800,
    backendPendingAtVerification: true,
    transcribed: true,
    pcm,
  },
};
it("requires two actual audio responses before releasing the same work", () =>
  expect(assessConversation(evidence).passed).toBe(true));
it("rejects a final result alone, silence, or text-only acknowledgement", () => {
  expect(assessConversation({ callbackCount: 1, resolvedAtMs: 1000 }).passed).toBe(false);
  expect(
    assessConversation({ ...evidence, ack: { ...evidence.ack, pcm: { ...pcm, windowPeak: 0 } } })
      .passed,
  ).toBe(false);
});
it("rejects ack followed by silence, a reused first turn, or re-delegation", () => {
  expect(assessConversation({ ...evidence, exchange: undefined }).passed).toBe(false);
  expect(
    assessConversation({ ...evidence, exchange: { ...evidence.exchange, turnId: "a" } }).passed,
  ).toBe(false);
  expect(assessConversation({ ...evidence, callbackCount: 2 }).passed).toBe(false);
});
it("rejects second speech after completion or an unheard second question", () => {
  expect(
    assessConversation({ ...evidence, exchange: { ...evidence.exchange, verifiedAtMs: 1001 } })
      .passed,
  ).toBe(false);
  expect(
    assessConversation({ ...evidence, exchange: { ...evidence.exchange, transcribed: false } })
      .passed,
  ).toBe(false);
});

it("records independent pending-work audio even if the backend never completes", () => {
  expect(assessConversation({ ...evidence, resolvedAtMs: undefined }).passed).toBe(true);
  expect(
    assessConversation({
      ...evidence,
      ack: { ...evidence.ack, backendPendingAtVerification: false },
    }).passed,
  ).toBe(false);
  expect(assessConversation({ ...evidence, prematureMarker: true }).passed).toBe(false);
});
