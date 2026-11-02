import * as Schema from "effect/Schema";
import { SlackCollectionPage } from "./slackTaskRules.ts";

const SearchResponse = Schema.Struct({ results: Schema.String, pagination_info: Schema.String });
const decodeSearch = Schema.decodeUnknownSync(SearchResponse);
const decodePage = Schema.decodeUnknownSync(SlackCollectionPage);

/** The native connector returns a text envelope, not raw Slack events.
 * Reject changed or ambiguous layouts rather than advance past unreadable messages. */
export function parseSlackSearchPage(input: unknown, workspaceId: string): SlackCollectionPage {
  const { results, pagination_info } = decodeSearch(input);
  const nextCursor =
    /For the next page of results use cursor `([^`]+)`/.exec(pagination_info)?.[1] ?? null;
  if (!nextCursor && !pagination_info.startsWith("End of results - No more pages available.")) {
    throw new Error("Unrecognized Slack pagination");
  }
  if (/^# Search Results for: [^\n]*\n\nNo results found\.\n?$/.test(results)) {
    if (nextCursor) throw new Error("Empty Slack page has a cursor");
    return { messages: [], nextCursor: null };
  }
  const count = /^## Messages \((\d+) results\)$/m.exec(results)?.[1];
  const sections = results.split(/^### Result \d+ of \d+\n/m).slice(1);
  if (count === undefined || sections.length !== Number(count) || sections.length === 0) {
    throw new Error("Unrecognized Slack search results");
  }
  const messages = sections.map((section) => {
    const match =
      /^Channel: (.*?) \(ID: ([A-Z0-9]+)\)\n(?:Participants: [^\n]*\n)?From: [^\n]*\(ID: ([A-Z0-9]+)\)[^\n]*\nTime: [^\n]*\nMessage_ts: (\d+\.\d{6})\n(?:Reply count: \d+\n)?Permalink: \[link\]\((https:\/\/[^\s)]+)\)\nText: ?\n([\s\S]*)\n\n---\n\n$/.exec(
        section,
      );
    if (!match) throw new Error("Unrecognized Slack message layout");
    const [, channelName, channelId, authorId, ts, permalink, text] = match;
    const url = new URL(permalink!);
    if (
      !url.hostname.endsWith(".slack.com") ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== `/archives/${channelId}/p${ts!.replace(".", "")}`
    ) {
      throw new Error("Slack message identity does not match its link");
    }
    return {
      workspaceId,
      channelId,
      channelName,
      authorId,
      ts,
      threadTs: url.searchParams.get("thread_ts") ?? ts,
      text,
    };
  });
  return decodePage({ messages, nextCursor });
}
