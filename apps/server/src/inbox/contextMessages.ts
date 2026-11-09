import type { InboxContextResult, InboxSource } from "@t3tools/contracts";

const timestamp = (source: typeof InboxSource.Type) =>
  source.kind === "gmail" ? source.message.receivedAt : source.message.ts;
const micros = (value: string) => {
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!);
};
const identity = (source: typeof InboxSource.Type) =>
  source.kind === "gmail" ? source.message.id : source.message.ts;

export function selectContext(
  target: typeof InboxSource.Type,
  candidates: ReadonlyArray<typeof InboxSource.Type>,
  incomplete = false,
): InboxContextResult {
  const before = micros(timestamp(target));
  const previous = new Map<string, typeof InboxSource.Type>();
  for (const source of candidates) {
    if (source.kind !== target.kind) throw new Error("Context source mismatch");
    if (source.kind === "gmail" && target.kind === "gmail") {
      if (
        source.message.accountEmail !== target.message.accountEmail ||
        source.message.threadId !== target.message.threadId
      )
        throw new Error("Context Gmail exchange mismatch");
    } else if (source.kind === "slack" && target.kind === "slack") {
      if (
        source.message.workspaceId !== target.message.workspaceId ||
        source.message.channelId !== target.message.channelId ||
        (target.message.threadTs !== target.message.ts &&
          source.message.threadTs !== target.message.threadTs)
      )
        throw new Error("Context Slack exchange mismatch");
    }
    if (identity(source) !== identity(target) && micros(timestamp(source)) < before)
      previous.set(identity(source), source);
  }
  const sorted = [...previous.values()].sort((a, b) =>
    micros(timestamp(a)) < micros(timestamp(b)) ? -1 : 1,
  );
  const keepFirst = target.kind === "gmail" || target.message.threadTs !== target.message.ts;
  const selected =
    sorted.length <= 5 ? sorted : keepFirst ? [sorted[0]!, ...sorted.slice(-4)] : sorted.slice(-5);
  let remaining = 10_000;
  let truncated = incomplete || sorted.length > selected.length;
  // Share the text budget so a long initial message cannot hide the recent replies.
  const messages = selected.map((source, index) => {
    const allowance = Math.floor(remaining / (selected.length - index));
    let text = source.message.text.slice(0, allowance);
    if (text.length < source.message.text.length) truncated = true;
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    remaining -= text.length;
    return { ...source, message: { ...source.message, text } } as typeof InboxSource.Type;
  });
  return {
    status: incomplete ? "partial" : "ready",
    messages,
    truncated,
    reason: incomplete ? "limit" : null,
  };
}
