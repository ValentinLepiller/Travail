import { SlackTaskMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SlackTaskRules = Schema.Struct({
  enabled: Schema.Boolean,
  workspaceId: SlackTaskMessage.fields.workspaceId,
  excludeChannelNames: Schema.Array(Schema.String),
  excludeAuthorIds: Schema.Array(Schema.String),
  excludeText: Schema.Array(Schema.String),
  collector: Schema.Struct({
    executable: Schema.NonEmptyString,
    args: Schema.Array(Schema.String),
    cwd: Schema.NonEmptyString,
    codexHome: Schema.NonEmptyString,
    linkId: Schema.optionalKey(Schema.String),
  }),
});
export type SlackTaskRules = typeof SlackTaskRules.Type;

export const SlackCollectionInput = Schema.Struct({
  workspaceId: SlackTaskMessage.fields.workspaceId,
  after: Schema.String,
  before: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  linkId: Schema.optionalKey(Schema.String),
});
export type SlackCollectionInput = typeof SlackCollectionInput.Type;
export const SlackCollectionPage = Schema.Struct({
  messages: Schema.Array(SlackTaskMessage).check(Schema.isMaxLength(20)),
  nextCursor: Schema.NullOr(Schema.String),
});
export type SlackCollectionPage = typeof SlackCollectionPage.Type;

/** Rules are reloaded from the shared file for each collection pass. */
export function acceptsSlackMessage(rules: SlackTaskRules, message: SlackTaskMessage): boolean {
  const channel = message.channelName.replace(/^#/, "").toLowerCase();
  return (
    message.workspaceId === rules.workspaceId &&
    !rules.excludeChannelNames.some((name) => name.replace(/^#/, "").toLowerCase() === channel) &&
    !rules.excludeAuthorIds.includes(message.authorId) &&
    !rules.excludeText.some(
      (text) => text.length > 0 && message.text.toLowerCase().includes(text.toLowerCase()),
    )
  );
}
