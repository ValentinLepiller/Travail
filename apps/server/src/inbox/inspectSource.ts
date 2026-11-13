import * as DateTime from "effect/DateTime";
import type { InboxSource } from "@t3tools/contracts";
import {
  parseGmailContext,
  parseSlackContext,
  type SourceInspection,
} from "./contextSourcePages.ts";
import { decodeGmailSearch, parseGmailMessage } from "../workTasks/gmailSearchPage.ts";
import { parseSlackSearchPage } from "../workTasks/slackSearchPage.ts";
import { readSlackImage } from "./slackImages.ts";
import { readSlackMessage } from "./readSlackMessage.ts";

export type InspectionCall = (
  operation:
    | "gmail.thread"
    | "gmail.search"
    | "gmail.read"
    | "slack.read"
    | "slack.readChannel"
    | "slack.searchAll"
    | "slack.file",
  args: Record<string, unknown>,
) => Promise<unknown>;

// Unlike collection context, a decision needs replies posted after the Inbox entry as well.
export async function inspectSource(
  source: typeof InboxSource.Type,
  call: InspectionCall,
  query?: string,
  attachmentsDir?: string,
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
    messages = await Promise.all(
      messages.map(async (entry) =>
        entry.kind === "slack"
          ? { kind: "slack" as const, message: await readSlackMessage(entry.message, call) }
          : entry,
      ),
    );
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
      try {
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
      } catch {
        incomplete = true;
      }
    }
    if (!messages.some((m) => m.kind === "slack" && m.message.ts === source.message.ts)) {
      try {
        messages.unshift({ kind: "slack", message: await readSlackMessage(source.message, call) });
      } catch {
        incomplete = true;
      }
    }
  }
  const unique = new Map<string, typeof InboxSource.Type>();
  for (const message of messages) {
    const key = message.kind === "gmail" ? message.message.id : message.message.ts;
    if (!unique.has(key)) unique.set(key, message);
  }
  const sorted = [...unique.values()].sort(
    (a, b) =>
      Number(a.kind === "gmail" ? a.message.receivedAt : a.message.ts) -
      Number(b.kind === "gmail" ? b.message.receivedAt : b.message.ts),
  );
  const targetId = source.kind === "gmail" ? source.message.id : source.message.ts;
  const target = unique.get(targetId);
  const candidates = sorted.filter((m) => m !== target);
  const selected = target ? [target, ...candidates.slice(-11)] : sorted.slice(-12);
  if (!query && !target) incomplete = true;
  const images: NonNullable<SourceInspection["images"]>[number][] = [];
  const imageFiles = new Set<string>();
  const warnings: string[] = [];
  for (const message of selected) {
    if (message.kind !== "slack") continue;
    for (const file of message.message.files ?? []) {
      if (!file.mimeType.startsWith("image/") || imageFiles.has(file.id)) continue;
      imageFiles.add(file.id);
      if (!attachmentsDir || images.length >= 4) {
        incomplete = true;
        warnings.push(`Image ${file.id} non lue (limite ou lecture indisponible).`);
        continue;
      }
      try {
        images.push({
          messageTs: message.message.ts,
          fileId: file.id,
          attachment: await readSlackImage(message.message.workspaceId, file, attachmentsDir, call),
        });
      } catch {
        incomplete = true;
        warnings.push(`Image ${file.id} indisponible : contenu non lu.`);
      }
    }
  }
  let remaining = 9000;
  const compact = selected.map((s, index) => {
    const allowance =
      s === target ? Math.min(4000, remaining) : Math.floor(remaining / (selected.length - index));
    const text = s.message.text.slice(0, allowance);
    incomplete ||= text.length < s.message.text.length;
    remaining -= text.length;
    return { ...s, message: { ...s.message, text } };
  });
  let text =
    (warnings.length ? `${warnings.slice(0, 4).join("\n")}\n` : "") + JSON.stringify(compact);
  incomplete ||= selected.length < sorted.length || text.length > 12_000;
  text = text.slice(0, 12_000);
  return {
    status: incomplete ? "partial" : "ready",
    checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    text,
    truncated: incomplete,
    ...(images.length ? { images } : {}),
  };
}
