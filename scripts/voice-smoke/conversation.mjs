export function assessConversation({
  callbackCount,
  resolvedAtMs,
  ack,
  exchange,
  prematureMarker,
}) {
  const failures = [];
  if (callbackCount !== 1) failures.push("conversation_restarted_or_redelegated_work");
  const audible = (part) =>
    part?.pcm?.windowNonDtxPackets >= 5 && part.pcm.windowRms > 2 && part.pcm.windowPeak > 32;
  if (
    !audible(ack) ||
    !ack.backendPendingAtVerification ||
    (resolvedAtMs !== undefined && ack.verifiedAtMs > resolvedAtMs)
  )
    failures.push("ack_audio_before_backend_missing");
  if (
    !audible(exchange) ||
    !exchange.backendPendingAtVerification ||
    !exchange.transcribed ||
    (resolvedAtMs !== undefined && exchange.verifiedAtMs > resolvedAtMs) ||
    exchange.turnId === ack?.turnId
  )
    failures.push("second_exchange_audio_before_backend_missing");
  if (prematureMarker) failures.push("result_claimed_before_backend_resolution");
  return { passed: failures.length === 0, failures };
}
