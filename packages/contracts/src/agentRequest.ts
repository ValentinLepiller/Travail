import { ChantierV2Command } from "./workChantierV2.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, ThreadId } from "./baseSchemas.ts";
import { WorkSource } from "./workChantier.ts";

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
export const AgentRequestSource = Schema.Struct({
  ...WorkSource.fields,
  text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(6000))),
  author: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export const AgentRequestAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), instruction: ShortText }),
  Schema.Struct({
    kind: Schema.Literal("command"),
    label: ShortText,
    executable: ShortText,
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(10_000))).check(
      Schema.isMaxLength(100),
    ),
    cwd: ShortText,
  }),
]);
export const AgentRequestContent = Schema.Struct({
  chantierApproval: Schema.optionalKey(ChantierV2Command),
  source: Schema.optionalKey(Schema.NullOr(AgentRequestSource)),
  sourceTaskId: Schema.optionalKey(ShortText),
  qualification: Schema.optionalKey(
    Schema.Struct({
      decision: Schema.Literals(["keep", "reject"]),
      source: ShortText,
    }),
  ),
  context: ShortText,
  question: ShortText,
  details: Schema.String.check(Schema.isMaxLength(50_000)),
  kind: Schema.Literals(["approval", "text"]),
  action: Schema.NullOr(AgentRequestAction),
});
export const AgentRequestCreate = Schema.Struct({
  ...AgentRequestContent.fields,
  id: ShortText,
});
export type AgentRequestCreate = typeof AgentRequestCreate.Type;
export const AgentRequest = Schema.Struct({
  ...AgentRequestCreate.fields,
  autonomousAgent: Schema.optionalKey(
    Schema.Struct({
      name: ShortText,
      qualifier: Schema.Boolean,
      source: Schema.NullOr(Schema.String),
    }),
  ),
  threadId: ThreadId,
  version: NonNegativeInt,
  status: Schema.Literals([
    "pending",
    "revision",
    "accepted",
    "rejected",
    "answered",
    "withdrawn",
    "ignored",
  ]),
  response: Schema.String,
  history: Schema.Array(Schema.Struct({ at: Schema.String, text: Schema.String })),
  actionStatus: Schema.Literals(["idle", "running", "succeeded", "failed", "uncertain"]),
  delivery: Schema.Literals(["none", "pending", "sent", "failed"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AgentRequest = typeof AgentRequest.Type;
export const AgentRequestUpdate = Schema.Struct({
  ...AgentRequestCreate.fields,
  expectedVersion: NonNegativeInt,
  withdraw: Schema.Boolean,
});
export type AgentRequestUpdate = typeof AgentRequestUpdate.Type;
export const AgentRequestRespond = Schema.Struct({
  id: ShortText,
  expectedVersion: NonNegativeInt,
  decision: Schema.Literals(["accept", "reject", "revise", "answer", "ignore"]),
  text: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type AgentRequestRespond = typeof AgentRequestRespond.Type;
export const AgentRequestComplete = Schema.Struct({
  id: ShortText,
  expectedVersion: NonNegativeInt,
  succeeded: Schema.Boolean,
  summary: ShortText,
});
export type AgentRequestComplete = typeof AgentRequestComplete.Type;
export const AgentRequestRetry = Schema.Struct({ id: ShortText, expectedVersion: NonNegativeInt });
export class AgentRequestError extends Schema.TaggedError<AgentRequestError>()(
  "AgentRequestError",
  {
    reason: Schema.Literals(["storage", "conflict", "invalid", "agent"]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "storage":
        return "Impossible de lire ou enregistrer les requêtes.";
      case "conflict":
        return "Cette requête a changé. Actualise avant de réessayer.";
      case "invalid":
        return "Cette action n’est pas disponible pour cette requête.";
      case "agent":
        return "La discussion d’origine n’est plus disponible.";
    }
  }
}
