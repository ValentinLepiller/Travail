import * as Schema from "effect/Schema";
import type { GmailTaskMessage } from "./gmailTaskRules.ts";

const Part = Schema.Struct({
  mime_type: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(
    Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
  parts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const decodePart = Schema.decodeUnknownSync(Part);
function plainText(input: unknown, depth = 0): string {
  if (depth > 20) return "";
  const part = decodePart(input);
  if (part.mime_type === "text/plain") return part.body?.content ?? "";
  return (part.parts ?? []).map((child) => plainText(child, depth + 1)).join("\n");
}
const decodeMessage = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.NonEmptyString,
    thread_id: Schema.NonEmptyString,
    internal_date: Schema.String,
    snippet: Schema.optionalKey(Schema.String),
    payload: Schema.Struct({
      headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
      ...Part.fields,
    }),
  }),
);

export function parseGmailMessage(input: unknown, accountEmail: string): GmailTaskMessage {
  const message = decodeMessage(input);
  const receivedAt = Number(message.internal_date) / 1000;
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) throw new Error("Invalid Gmail timestamp");
  const header = (name: string) =>
    message.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return {
    accountEmail,
    id: message.id,
    threadId: message.thread_id,
    receivedAt: receivedAt.toFixed(6),
    sender: header("from"),
    subject: header("subject"),
    text: (plainText(message.payload) || message.snippet || "").slice(0, 100_000),
  };
}
export const decodeGmailSearch = Schema.decodeUnknownSync(
  Schema.Struct({
    message_ids: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(20)),
    next_page_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
