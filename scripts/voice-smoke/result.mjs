export const normalizeMarker = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function findResultTurn(turns, marker, resolvedAtMs) {
  if (resolvedAtMs === undefined) return undefined;
  const expected = ` ${normalizeMarker(marker)} `;
  return turns.find(
    (turn) =>
      turn.role === "assistant" &&
      turn.completed &&
      turn.endedAtMs >= resolvedAtMs &&
      ` ${normalizeMarker(turn.text)} `.includes(expected),
  );
}

export function assessResult({
  connected,
  channelOpened,
  callbackCount,
  matchedTurn,
  pcm,
  protocolError,
  encoderError,
}) {
  const failures = [];
  if (!connected || !channelOpened) failures.push("webrtc_not_ready");
  if (callbackCount !== 1) failures.push("expected_one_synthetic_callback");
  if (!matchedTurn) failures.push("completed_marker_response_missing");
  if (!pcm || pcm.decodeErrors.length || pcm.windowNonDtxPackets === 0 || pcm.windowPeak === 0) {
    failures.push("decoded_response_audio_missing");
  }
  if (protocolError) failures.push("realtime_protocol_error");
  if (encoderError) failures.push("audio_encoder_failed");
  return { passed: failures.length === 0, failures };
}
