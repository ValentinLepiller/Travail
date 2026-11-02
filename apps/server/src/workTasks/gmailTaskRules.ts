import * as Schema from "effect/Schema";
import { SlackTaskRules } from "./slackTaskRules.ts";
export const GmailTaskMessage = Schema.Struct({
  accountEmail: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  receivedAt: Schema.String.check(Schema.isPattern(/^\d{10,16}\.\d{6}$/)),
  sender: Schema.String,
  subject: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(100_000)),
});
export type GmailTaskMessage = typeof GmailTaskMessage.Type;
export const GmailTaskRules = Schema.Struct({
  enabled: Schema.Boolean,
  accountEmail: Schema.NonEmptyString,
  excludeSenders: Schema.Array(Schema.String),
  excludeText: Schema.Array(Schema.String),
  collector: SlackTaskRules.fields.collector,
});
export type GmailTaskRules = typeof GmailTaskRules.Type;
export const GmailCollectionInput = Schema.Struct({
  accountEmail: Schema.NonEmptyString,
  after: Schema.String,
  before: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  linkId: Schema.optionalKey(Schema.String),
});
export type GmailCollectionInput = typeof GmailCollectionInput.Type;
export const GmailCollectionPage = Schema.Struct({
  messages: Schema.Array(GmailTaskMessage).check(Schema.isMaxLength(20)),
  nextCursor: Schema.NullOr(Schema.String),
});
export type GmailCollectionPage = typeof GmailCollectionPage.Type;
export function acceptsGmailMessage(rules: GmailTaskRules, message: GmailTaskMessage): boolean {
  return (
    message.accountEmail === rules.accountEmail &&
    !rules.excludeSenders.some((sender) =>
      message.sender.toLowerCase().includes(sender.toLowerCase()),
    ) &&
    !rules.excludeText.some(
      (text) =>
        text.length > 0 &&
        `${message.subject} ${message.text}`.toLowerCase().includes(text.toLowerCase()),
    )
  );
}
