import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const MessageKey = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const ChefScope = Schema.Struct({
  kind: Schema.Literals(["global", "project", "chantier", "sender"]),
  id: Schema.NullOr(Text),
});
export const ChefMemoryDraft = Schema.Struct({
  kind: Schema.Literals(["fact", "rule"]),
  text: Text,
  scope: ChefScope,
  topic: Text,
  action: Schema.NullOr(Schema.Literals(["create", "complete", "ignore", "handoff"])),
});
export type ChefMemoryDraft = typeof ChefMemoryDraft.Type;
export const ChefMemory = Schema.Struct({
  ...ChefMemoryDraft.fields,
  id: Text,
  version: NonNegativeInt,
  enabled: Schema.Boolean,
  sourceRequestId: Schema.NullOr(Text),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ChefMemory = typeof ChefMemory.Type;

export const ChefAction = Schema.Literals(["create", "complete", "ignore", "handoff", "remember"]);
export const chefActionLabels = {
  create: "Créer la tâche",
  complete: "Compléter la tâche",
  ignore: "Ignorer le sujet",
  handoff: "Consulter le Chef responsable",
  remember: "Mémoriser",
};
export const ChefRequest = Schema.Struct({
  action: Schema.optionalKey(ChefAction),
  subjectTitle: Schema.optionalKey(Text),
  summary: Schema.optionalKey(Text),
  reviewPending: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  decisionId: Text,
  dossierIds: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  memory: Schema.NullOr(ChefMemoryDraft),
  remember: Schema.optionalKey(Schema.Boolean),
  memoryOnly: Schema.optionalKey(Schema.Boolean),
});
export type ChefRequest = typeof ChefRequest.Type;

export const ChefSettings = Schema.Struct({
  enabled: Schema.Boolean,
  projectId: Schema.NullOr(ProjectId),
  modelSelection: Schema.NullOr(ModelSelection),
});
export const ChefDossier = Schema.Struct({
  id: Text,
  threadId: ThreadId,
  subjectId: Text,
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  title: Schema.String,
  state: Schema.Literals(["pending", "processing", "waiting", "done", "error", "closed"]),
  requestId: Schema.NullOr(Text),
  error: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type ChefDossier = typeof ChefDossier.Type;
export const GlobalChefMessage = Schema.Struct({
  sequence: NonNegativeInt,
  id: Text,
  role: Schema.Literals(["user", "assistant", "event", "chef"]),
  text: Schema.String,
  createdAt: Schema.String,
});
export const ChefDossierDetail = Schema.Struct({
  dossier: ChefDossier,
  messages: Schema.Array(GlobalChefMessage),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const ChefPageInput = Schema.Struct({
  after: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  archived: Schema.optionalKey(Schema.Boolean),
});
export const ChefDossiersPage = Schema.Struct({
  dossiers: Schema.Array(ChefDossier),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const ChefMemoryPage = Schema.Struct({
  memories: Schema.Array(ChefMemory),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const ChefReadInput = Schema.Struct({
  id: Text,
  before: Schema.optionalKey(NonNegativeInt),
});
export const ChefStatus = Schema.Struct({
  settings: ChefSettings,
  pending: NonNegativeInt,
  processing: NonNegativeInt,
  waiting: NonNegativeInt,
  done: NonNegativeInt,
  errors: NonNegativeInt,
  notificationsPending: NonNegativeInt,
});
export const ChefDossierReplyInput = Schema.Struct({
  id: Text,
  messageId: MessageKey,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
});
export const ChefCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("configure"), ...ChefSettings.fields }),
  Schema.Struct({
    type: Schema.Literal("message"),
    id: Text,
    messageId: MessageKey,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  }),
  Schema.Struct({ type: Schema.Literal("retry"), id: Text }),
  Schema.Struct({
    type: Schema.Literal("memory"),
    ...ChefMemoryDraft.fields,
    id: Text,
    expectedVersion: NonNegativeInt,
    enabled: Schema.Boolean,
  }),
]);
export type ChefCommand = typeof ChefCommand.Type;
export class ChefError extends Schema.TaggedError<ChefError>()("ChefError", {
  reason: Schema.Literals([
    "storage",
    "conflict",
    "missing",
    "configuration",
    "model",
    "format",
    "limit",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "conflict":
        return "Ce dossier ou cette mémoire a changé. Actualise avant de réessayer.";
      case "missing":
        return "Ce dossier n’est plus disponible.";
      case "configuration":
        return "Choisis le projet d’accueil et le modèle du Chef avant de l’activer.";
      case "model":
        return "Le Chef n’a pas pu terminer sa réponse. Une reprise est prévue.";
      case "format":
        return "La proposition du Chef n’est pas valide. Aucune action n’a été appliquée.";
      case "limit":
        return "Le contexte dépasse la limite du Chef. Ce dossier demande une reprise.";
      default:
        return "Impossible de lire ou enregistrer le Chef.";
    }
  }
}

export const chefDossierThreadPrefix = "chef-dossier:";
export const isChefDossierThread = (id: string) => id.startsWith(chefDossierThreadPrefix);
export const isChefError = Schema.is(ChefError);
