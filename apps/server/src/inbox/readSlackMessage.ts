import type { SlackTaskMessage } from "@t3tools/contracts";
import { parseSlackContext } from "./contextSourcePages.ts";
import type { ContextConnectorCall } from "./readSourceContext.ts";

// Search drops forwards and files. Fetch the exact message before qualifying it.
export async function readSlackMessage(message: SlackTaskMessage, call: ContextConnectorCall) {
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const page = parseSlackContext(
      await call("slack.read", {
        channel_id: message.channelId,
        message_ts: message.threadTs,
        limit: 20,
        response_format: "detailed",
        ...(cursor ? { cursor } : {}),
      }),
      message,
      true,
    );
    const current = page.sources.find(
      (source) => source.kind === "slack" && source.message.ts === message.ts,
    );
    if (current?.kind === "slack") {
      if (current.message.authorId !== message.authorId) throw new Error("Slack author mismatch");
      return current.message;
    }
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  throw new Error("Slack target message unavailable");
}
