import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const AgentRequestChatMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.String,
});
export type AgentRequestChatMessage = typeof AgentRequestChatMessage.Type;

export const AgentRequestChat = Schema.Struct({
  messages: Schema.Array(AgentRequestChatMessage),
  modelSelection: Schema.NullOr(ModelSelection),
  activeMessageId: Schema.NullOr(Schema.String),
  sourceVersion: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String),
});
export type AgentRequestChat = typeof AgentRequestChat.Type;

export const AgentRequestChatInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const AgentRequestChatSend = Schema.Struct({
  ...AgentRequestChatInput.fields,
  messageId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  modelSelection: ModelSelection,
});
export type AgentRequestChatSend = typeof AgentRequestChatSend.Type;

export class AgentRequestChatError extends Schema.TaggedError<AgentRequestChatError>()(
  "AgentRequestChatError",
  {
    reason: Schema.Literals(["storage", "missing", "busy", "source", "capacity"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "storage":
        return "Impossible de lire ou enregistrer la discussion temporaire.";
      case "missing":
        return "Cette requête est indisponible.";
      case "busy":
        return "Une réponse est déjà en cours pour cette requête.";
      case "source":
        return "Impossible de charger le contexte complet de la discussion d’origine.";
      case "capacity":
        return "Plusieurs réponses sont déjà en cours. Réessaie lorsqu’elles sont terminées.";
    }
  }
}
