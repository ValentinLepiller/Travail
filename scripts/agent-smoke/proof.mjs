export function observeItem(proof, threadId, item, markers) {
  if (
    [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "webSearch",
      "imageGeneration",
      "imageView",
    ].includes(item.type)
  ) {
    proof.disallowedActions.add(item.type);
  }
  if (item.type === "agentMessage" && threadId === proof.parentId) {
    if (item.phase !== "commentary") {
      proof.parentMarker = item.text?.includes(markers.parent) ?? false;
      proof.parentReturnedChildMarker = item.text?.includes(markers.child) ?? false;
    }
  }
  if (
    item.type === "agentMessage" &&
    proof.children.has(threadId) &&
    item.text?.includes(markers.child)
  ) {
    proof.childMarkerObserved.add(threadId);
  }
  if (
    item.type === "subAgentActivity" &&
    threadId === proof.parentId &&
    item.agentThreadId !== proof.parentId
  ) {
    if (item.kind === "started") proof.children.add(item.agentThreadId);
    if (item.kind === "completed" && proof.children.has(item.agentThreadId))
      proof.completedChildren.add(item.agentThreadId);
  }
  if (
    item.type !== "collabAgentToolCall" ||
    item.senderThreadId !== proof.parentId ||
    item.status !== "completed"
  )
    return;
  if (item.tool === "spawnAgent") {
    for (const id of item.receiverThreadIds) proof.children.add(id);
  }
  for (const [id, state] of Object.entries(item.agentsStates ?? {})) {
    if (proof.children.has(id) && state.status === "completed") {
      proof.completedChildren.add(id);
      if (state.message?.includes(markers.child)) proof.childMarkerObserved.add(id);
    }
  }
}

export function assessProof(proof) {
  const failures = [];
  const children = [...proof.children];
  if (children.length !== 1 || children[0] === proof.parentId)
    failures.push("one_distinct_native_child_required");
  if (
    !children.some(
      (id) =>
        proof.completedChildren.has(id) &&
        proof.childMarkerObserved.has(id) &&
        proof.verifiedChildHistories.has(id),
    )
  )
    failures.push("native_completed_child_marker_missing");
  if (!proof.parentCompleted || !proof.parentMarker || !proof.parentReturnedChildMarker)
    failures.push("parent_result_missing");
  if (proof.disallowedActions.size) failures.push("disallowed_action_observed");
  return { passed: failures.length === 0, failures };
}

// Keep diagnostics useful without retaining provider messages, headers or request content.
export function providerFailure(error) {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : (Object.keys(info ?? {})[0] ?? "unknown");
  const status = typeof info === "object" && info !== null ? info[kind]?.httpStatusCode : undefined;
  return { kind, ...(Number.isInteger(status) ? { httpStatusCode: status } : {}) };
}
