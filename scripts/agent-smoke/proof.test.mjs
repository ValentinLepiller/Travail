import { expect, it } from "vitest";
import { assessProof, observeItem } from "./proof.mjs";

const markers = { parent: "parent-code", child: "child-code" };
function proof() {
  return {
    parentId: "parent",
    parentCompleted: true,
    parentMarker: false,
    parentReturnedChildMarker: false,
    children: new Set(),
    completedChildren: new Set(),
    childMarkerObserved: new Set(),
    verifiedChildHistories: new Set(),
    disallowedActions: new Set(),
  };
}
const spawn = {
  type: "collabAgentToolCall",
  tool: "spawnAgent",
  senderThreadId: "parent",
  status: "completed",
  receiverThreadIds: ["child"],
  agentsStates: { child: { status: "running" } },
};
const done = {
  ...spawn,
  tool: "wait",
  agentsStates: { child: { status: "completed", message: "child-code" } },
};
const answer = { type: "agentMessage", text: "parent-code child-code" };

it("does not accept a parent's declaration of delegation without a real native child", () => {
  const p = proof();
  observeItem(p, "parent", answer, markers);
  expect(assessProof(p).passed).toBe(false);
});
it("requires the spawned child to finish with its marker before accepting the parent result", () => {
  const p = proof();
  observeItem(p, "parent", answer, markers);
  observeItem(p, "parent", spawn, markers);
  expect(assessProof(p).passed).toBe(false);
  observeItem(p, "parent", done, markers);
  p.verifiedChildHistories.add("child");
  expect(assessProof(p).passed).toBe(true);
});
it("rejects another parent's events, duplicate children, or an external action", () => {
  const p = proof();
  observeItem(p, "parent", answer, markers);
  observeItem(p, "parent", { ...spawn, senderThreadId: "unrelated" }, markers);
  observeItem(p, "parent", done, markers);
  expect(assessProof(p).passed).toBe(false);
  observeItem(p, "parent", spawn, markers);
  observeItem(p, "parent", done, markers);
  p.verifiedChildHistories.add("child");
  expect(assessProof(p).passed).toBe(true);
  observeItem(p, "parent", { ...spawn, receiverThreadIds: ["extra-child"] }, markers);
  expect(assessProof(p).passed).toBe(false);
  p.children.delete("extra-child");
  expect(assessProof(p).passed).toBe(true);
  observeItem(p, "parent", { type: "mcpToolCall" }, markers);
  expect(assessProof(p).passed).toBe(false);
});

it("does not accept markers quoted in commentary instead of the final parent result", () => {
  const p = proof();
  observeItem(p, "parent", { ...answer, phase: "commentary" }, markers);
  observeItem(p, "parent", spawn, markers);
  observeItem(p, "parent", done, markers);
  p.verifiedChildHistories.add("child");
  observeItem(
    p,
    "parent",
    { type: "agentMessage", text: "Could not return the result.", phase: "final_answer" },
    markers,
  );
  expect(assessProof(p).passed).toBe(false);
});

it("accepts current native activity events only with the child's own completed result", () => {
  const p = proof();
  observeItem(p, "parent", answer, markers);
  observeItem(
    p,
    "parent",
    { type: "subAgentActivity", kind: "started", agentThreadId: "child" },
    markers,
  );
  observeItem(
    p,
    "parent",
    { type: "subAgentActivity", kind: "completed", agentThreadId: "child" },
    markers,
  );
  expect(assessProof(p).passed).toBe(false);
  observeItem(p, "child", { type: "agentMessage", text: "child-code" }, markers);
  expect(assessProof(p).passed).toBe(false);
  p.verifiedChildHistories.add("child");
  expect(assessProof(p).passed).toBe(true);
});
