import { ChatImageAttachment, GmailTaskMessage, InboxSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseGmailMessage } from "../workTasks/gmailSearchPage.ts";

export const InboxContextReadInput = Schema.Struct({
  source: InboxSource,
  linkId: Schema.optionalKey(Schema.String),
  inspect: Schema.optionalKey(Schema.Boolean),
  query: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(300))),
  attachmentsDir: Schema.optionalKey(Schema.NonEmptyString),
});

const decodeSnippet = Schema.decodeUnknownSync(
  Schema.Struct({ snippet: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);
const decodeThread = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    messages: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100)),
  }),
);
const decodeText = Schema.decodeUnknownSync(
  Schema.Struct({ messages: Schema.String, pagination_info: Schema.String }),
);
const validateSource = Schema.decodeUnknownSync(InboxSource);

export function parseGmailContext(input: unknown, target: GmailTaskMessage) {
  const thread = decodeThread(input);
  if (thread.id !== target.threadId) throw new Error("Wrong Gmail thread");
  const sources = thread.messages.map((message) => ({
    kind: "gmail" as const,
    message: parseGmailMessage(message, target.accountEmail),
  }));
  const truncated = thread.messages.some((message, index) => {
    const { snippet } = decodeSnippet(message);
    return !!snippet && sources[index]!.message.text === snippet;
  });
  return {
    sources,
    truncated,
    incomplete:
      thread.messages.length >= 100 || !sources.some((source) => source.message.id === target.id),
  };
}

export function parseSlackContext(
  input: unknown,
  target: Extract<typeof InboxSource.Type, { kind: "slack" }>["message"],
  threaded: boolean,
) {
  const data = decodeText(input);
  let nextCursor: string | null = null;
  if (threaded) {
    nextCursor = /cursor[: ]+`([^`]+)`/i.exec(data.pagination_info)?.[1] ?? null;
    if (
      !nextCursor &&
      !/^There are no more messages in this thread\.\s*$/.test(data.pagination_info)
    )
      throw new Error("Unknown Slack thread pagination");
  } else {
    nextCursor = /use cursor: `([^`]+)`/.exec(data.pagination_info)?.[1] ?? null;
    if (!nextCursor && !/no more messages/i.test(data.pagination_info))
      throw new Error("Unknown Slack channel pagination");
    const channel = /^Channel: [^\n]*\(([A-Z0-9]+)\)\n/.exec(data.messages)?.[1];
    if (channel !== target.channelId) throw new Error("Wrong Slack channel");
  }
  const blocks = threaded
    ? data.messages
        .split(
          /^(?:=== THREAD PARENT MESSAGE ===|=== THREAD REPLIES \(\d+ total\) ===|--- Reply \d+ of \d+ ---)\s*\n/m,
        )
        .filter((part) => part.trim() && !/^No thread messsages\s*$/.test(part))
    : data.messages
        .replace(/^Channel: [^\n]*\n\n/, "")
        .split(/^=== Message from /m)
        .filter((part) => part.trim());
  const sources = blocks.map((block) => {
    const match = threaded
      ? /^From: (.*?) \(([A-Z0-9]+)(?:, external: [^\n]+)?\)\nTime: [^\n]+\nMessage TS: (\d+\.\d{6})\n([\s\S]*)$/.exec(
          block,
        )
      : /^(.*?) \(([A-Z0-9]+)(?:, external: [^\n]+)?\) at [^\n]+ === ?\nMessage TS: (\d+\.\d{6})\n([\s\S]*)$/.exec(
          block,
        );
    if (!match) throw new Error("Unknown Slack context layout");
    let text = match[4]!.replace(/\n\nNo thread messsages\s*$/, "").replace(/\n$/, "");
    const files = [...text.matchAll(/^Files: (.*)$/gm)].flatMap((line) =>
      [...line[1]!.matchAll(/(?:^|, )(.+?) \(ID: (F[A-Z0-9]+), ([^,\s]+), [^)]+\)/g)].map(
        (file) => ({ id: file[2]!, name: file[1]!, mimeType: file[3]! }),
      ),
    );
    const { files: _files, ...original } = target;
    return validateSource({
      kind: "slack",
      message: {
        ...original,
        authorId: match[2],
        authorName: match[1],
        ts: match[3],
        threadTs: threaded ? target.threadTs : match[3],
        text,
        ...(files.length ? { files } : {}),
      },
    });
  });
  if (
    threaded &&
    (!sources.length || sources[0]?.kind !== "slack" || sources[0].message.ts !== target.threadTs)
  )
    throw new Error("Slack thread parent missing");
  return { sources, nextCursor };
}

export const SourceInspection = Schema.Struct({
  status: Schema.Literals(["ready", "partial", "unavailable"]),
  checkedAt: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(12_000)),
  truncated: Schema.Boolean,
  images: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        messageTs: Schema.String,
        fileId: Schema.String,
        attachment: ChatImageAttachment,
      }),
    ).check(Schema.isMaxLength(4)),
  ),
});
export type SourceInspection = typeof SourceInspection.Type;
