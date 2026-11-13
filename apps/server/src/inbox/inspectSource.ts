import * as DateTime from "effect/DateTime";
import type { InboxSource } from "@t3tools/contracts";
import {
  parseGmailContext,
  parseSlackContext,
  type SourceInspection,
} from "./contextSourcePages.ts";
import { decodeGmailSearch, parseGmailMessage } from "../workTasks/gmailSearchPage.ts";
import { parseSlackSearchPage } from "../workTasks/slackSearchPage.ts";

export type InspectionCall = (
  operation:
    | "gmail.thread"
    | "gmail.search"
    | "gmail.read"
    | "slack.read"
    | "slack.readChannel"
    | "slack.searchAll",
  args: Record<string, unknown>,
) => Promise<unknown>;

// Unlike collection context, a decision needs replies posted after the Inbox entry as well.
export async function inspectSource(
  source: typeof InboxSource.Type,
  call: InspectionCall,
  query?: string,
): Promise<SourceInspection> {
  let messages: Array<typeof InboxSource.Type>;
  let incomplete = false;
  if (source.kind === "gmail") {
    if (query) {
      const page = decodeGmailSearch(await call("gmail.search", { query, max_results: 3 }));
      incomplete = Boolean(page.next_page_token) || page.message_ids.length > 3;
      messages = [];
      for (const id of page.message_ids.slice(0, 3))
        messages.push({
          kind: "gmail",
          message: parseGmailMessage(
            await call("gmail.read", { message_id: id, format: "full" }),
            source.message.accountEmail,
          ),
        });
    } else {
      const page = parseGmailContext(
        await call("gmail.thread", { thread_id: source.message.threadId, max_messages: 100 }),
        source.message,
      );
      messages = page.sources;
      incomplete = page.incomplete || page.truncated;
    }
  } else if (query) {
    const keywords = query.match(/"[^"\n]+"|\S+/g) ?? [];
    const page = parseSlackSearchPage(
      await call("slack.searchAll", {
        keywords,
        limit: 5,
        response_format: "detailed",
        include_context: false,
        sort: "timestamp",
        sort_dir: "desc",
      }),
      source.message.workspaceId,
    );
    messages = page.messages.map((message) => ({ kind: "slack" as const, message }));
    incomplete = page.nextCursor !== null;
  } else {
    const thread = parseSlackContext(
      await call("slack.read", {
        channel_id: source.message.channelId,
        message_ts: source.message.threadTs,
        limit: 20,
        response_format: "detailed",
      }),
      source.message,
      true,
    );
    messages = thread.sources;
    incomplete = thread.nextCursor !== null;
    if (source.message.ts === source.message.threadTs) {
      const channel = parseSlackContext(
        await call("slack.readChannel", {
          channel_id: source.message.channelId,
          limit: 20,
          response_format: "detailed",
        }),
        source.message,
        false,
      );
      messages.push(...channel.sources);
      incomplete ||= channel.nextCursor !== null;
    }
  }
  const unique = new Map(
    messages.map((s) => [s.kind === "gmail" ? s.message.id : s.message.ts, s]),
  );
  const sorted = [...unique.values()].sort(
    (a, b) =>
      Number(a.kind === "gmail" ? a.message.receivedAt : a.message.ts) -
      Number(b.kind === "gmail" ? b.message.receivedAt : b.message.ts),
  );
  const selected = sorted.length > 12 ? [sorted[0]!, ...sorted.slice(-11)] : sorted;
  let remaining = 9000;
  const compact = selected.map((s, index) => {
    const allowance = Math.floor(remaining / (selected.length - index));
    const text = s.message.text.slice(0, allowance);
    incomplete ||= text.length < s.message.text.length;
    remaining -= text.length;
    return { ...s, message: { ...s.message, text } };
  });
  let text = JSON.stringify(compact);
  incomplete ||= selected.length < sorted.length || text.length > 12_000;
  text = text.slice(0, 12_000);
  return {
    status: incomplete ? "partial" : "ready",
    checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    text,
    truncated: incomplete,
  };
}
