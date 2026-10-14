import { describe, expect, it } from "vitest";
import { assessResult, findResultTurn } from "./result.mjs";

const response = {
  role: "assistant",
  completed: true,
  text: "The code is cobalt thirty-nine.",
  endedAtMs: 200,
};
const pcm = { decodeErrors: [], windowNonDtxPackets: 30, windowPeak: 1000 };
const evidence = {
  connected: true,
  channelOpened: true,
  callbackCount: 1,
  matchedTurn: response,
  pcm,
};

describe("a completed callback result is actually returned as voice", () => {
  it("accepts capitalization and punctuation in the spoken marker", () => {
    expect(findResultTurn([response], "Cobalt thirty nine", 100)).toBe(response);
    expect(assessResult(evidence).passed).toBe(true);
  });
  it("rejects an acknowledgement, an unfinished answer, or output before the callback", () => {
    expect(
      findResultTurn([{ ...response, text: "Working on it." }], "cobalt thirty nine", 100),
    ).toBeUndefined();
    expect(
      findResultTurn([{ ...response, completed: false }], "cobalt thirty nine", 100),
    ).toBeUndefined();
    expect(findResultTurn([response], "cobalt thirty nine", 300)).toBeUndefined();
  });
  it("rejects silence or audio outside the result turn despite a matching transcript", () => {
    expect(assessResult({ ...evidence, pcm: { ...pcm, windowPeak: 0 } }).passed).toBe(false);
    expect(assessResult({ ...evidence, pcm: { ...pcm, windowNonDtxPackets: 0 } }).passed).toBe(
      false,
    );
  });
  it("rejects duplicate work, an unestablished transport, and undecodable audio", () => {
    expect(assessResult({ ...evidence, callbackCount: 2 }).passed).toBe(false);
    expect(assessResult({ ...evidence, connected: false }).passed).toBe(false);
    expect(assessResult({ ...evidence, pcm: { ...pcm, decodeErrors: [-1] } }).passed).toBe(false);
  });
});
