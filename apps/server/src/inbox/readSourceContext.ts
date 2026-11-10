import type { InboxContextResult, InboxSource } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { selectContext } from "./contextMessages.ts";
import { parseGmailContext, parseSlackContext } from "./contextSourcePages.ts";

export type ContextConnectorCall = (
  operation: "gmail.thread" | "slack.read" | "slack.readChannel",
  args: Record<string, unknown>,
) => Promise<unknown>;

// The caller verifies the connector account once before reading a collection batch.
export async function readSourceContext(
  source: typeof InboxSource.Type,
  call: ContextConnectorCall,
): Promise<InboxContextResult> {
  const recovered: Array<typeof InboxSource.Type> = [];
  try {
    if (source.kind === "gmail") {
      const page = parseGmailContext(
        await call("gmail.thread", { thread_id: source.message.threadId, max_messages: 100 }),
        source.message,
      );
      const result = selectContext(source, page.sources, page.incomplete);
      return { ...result, truncated: result.truncated || page.truncated };
    }
    const threaded = source.message.threadTs !== source.message.ts;
    let cursor: string | null = null;
    for (let n = 0; n < (threaded ? 3 : 1); n++) {
      const page = parseSlackContext(
        await call(threaded ? "slack.read" : "slack.readChannel", {
          channel_id: source.message.channelId,
          ...(threaded ? { message_ts: source.message.threadTs } : {}),
          latest: source.message.ts,
          limit: 20,
          response_format: "detailed",
          ...(cursor ? { cursor } : {}),
        }),
        source.message,
        threaded,
      );
      recovered.push(...page.sources);
      if (page.nextCursor !== null && page.nextCursor === cursor)
        throw new Error("Pagination stalled");
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    let result = selectContext(source, recovered, threaded && cursor !== null);
    if (!threaded && cursor !== null)
      result = {
        ...result,
        truncated: true,
        ...(result.messages.length < 5 ? { status: "partial", reason: "limit" } : {}),
      };
    return result;
  } catch {
    return recovered.length
      ? { ...selectContext(source, recovered, true), reason: "source" }
      : { status: "unavailable", messages: [], truncated: false, reason: "source" };
  }
}

export async function collectContext(source: typeof InboxSource.Type, call: ContextConnectorCall) {
  const context = await readSourceContext(source, call);
  // A connector failure must leave the collection checkpoint unchanged, never look like an empty exchange.
  if (context.status === "unavailable" || context.reason === "source")
    throw new Error("Context fetch failed");
  return { ...context, version: 1 as const, checkedAt: DateTime.formatIso(DateTime.nowUnsafe()) };
}
