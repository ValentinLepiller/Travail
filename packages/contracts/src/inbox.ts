import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkTask, WorkTaskFields, SlackTaskMessage } from "./workTask.ts";

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

export const InboxSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("gmail"), message: GmailTaskMessage }),
  Schema.Struct({ kind: Schema.Literal("slack"), message: SlackTaskMessage }),
]);
export const InboxContextResult = Schema.Struct({
  status: Schema.Literals(["ready", "partial", "unavailable"]),
  messages: Schema.Array(InboxSource).check(
    Schema.isMaxLength(5),
    Schema.makeFilter(
      (messages) => messages.reduce((sum, source) => sum + source.message.text.length, 0) <= 10_000,
      { expected: "at most 10000 context text characters" },
    ),
  ),
  truncated: Schema.Boolean,
  reason: Schema.NullOr(Schema.Literals(["source", "configuration", "format", "limit"])),
});
export type InboxContextResult = typeof InboxContextResult.Type;
export const InboxContext = Schema.Struct({
  ...InboxContextResult.fields,
  version: Schema.Literal(1),
  checkedAt: Schema.String,
  batchId: Schema.optionalKey(Schema.String),
});
export type InboxContext = typeof InboxContext.Type;
export const InboxContextBackfillInput = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  retryUnavailableIds: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  ),
});
export const InboxContextBackfillResult = Schema.Struct({
  batchId: Schema.String,
  targets: Schema.Int,
  reviewed: Schema.Int,
  updated: Schema.Int,
  alreadyProcessed: Schema.Int,
  withContext: Schema.Int,
  empty: Schema.Int,
  failed: Schema.Int,
  partial: Schema.Int,
  remaining: Schema.Int,
});
export const InboxCategory = Schema.Literals([
  "no_action",
  "information",
  "personal_action",
  "technical_action",
  "unsure",
]);
export type InboxCategory = typeof InboxCategory.Type;
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const InboxProbabilities = Schema.Struct({
  no_action: Probability,
  information: Probability,
  personal_action: Probability,
  technical_action: Probability,
  unsure: Probability,
}).check(
  Schema.makeFilter(
    (values) => Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) < 0.01,
    { expected: "probabilities summing to one" },
  ),
);
export const InboxQualification = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("qualified"),
  category: InboxCategory,
  probabilities: InboxProbabilities,
  confidence: Probability,
  model: Schema.NonEmptyString,
  qualifiedAt: Schema.String,
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
export const InboxQualificationAttempt = Schema.Struct({
  status: Schema.Literals(["processing", "error"]),
  token: Schema.String,
  attempts: Schema.Int,
  nextAttemptAt: Schema.String,
  error: Schema.NullOr(Schema.Literals(["configuration", "api", "limit", "format", "network"])),
});
export const InboxQualificationStatus = Schema.Struct({
  enabled: Schema.Boolean,
  total: Schema.Int,
  qualified: Schema.Int,
  remaining: Schema.Int,
  errors: Schema.Int,
  categories: Schema.Struct({
    no_action: Schema.Int,
    information: Schema.Int,
    personal_action: Schema.Int,
    technical_action: Schema.Int,
    unsure: Schema.Int,
  }),
  usage: Schema.Struct({ input_tokens: Schema.Int, output_tokens: Schema.Int }),
  head: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      sequence: Schema.Int,
      state: Schema.Literals(["waiting_context", "pending", "processing", "error"]),
      attempt: Schema.optionalKey(InboxQualificationAttempt),
    }),
  ),
});
export const InboxQualificationControl = Schema.Struct({ enabled: Schema.Boolean });
export const InboxMessage = Schema.Struct({
  id: Schema.NonEmptyString,
  collectedAt: Schema.String,
  url: Schema.String,
  source: InboxSource,
  context: Schema.optionalKey(InboxContext),
  qualification: Schema.optionalKey(InboxQualification),
  qualificationAttempt: Schema.optionalKey(InboxQualificationAttempt),
});
const Cursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const InboxPaginationFields = {
  after: Schema.optionalKey(Cursor),
  order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
};
export const InboxListInput = Schema.Struct({
  ...InboxPaginationFields,
  processed: Schema.optionalKey(Schema.Boolean),
});
export const InboxReadInput = Schema.Struct({ id: InboxMessage.fields.id });
export const InboxPage = Schema.Struct({
  messages: Schema.Array(InboxMessage),
  nextCursor: Schema.NullOr(Cursor),
});

export type InboxMessage = typeof InboxMessage.Type;

export class InboxListError extends Schema.TaggedError<InboxListError>()("InboxListError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Impossible de charger l’inbox.";
  }
}

export const InboxSubject = Schema.Struct({
  sequence: Schema.Int,
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString.check(Schema.isMaxLength(160)),
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(1200)),
  createdAt: Schema.String,
  entries: Schema.Int,
  actionVersion: Schema.optionalKey(NonNegativeInt),
  ignored: Schema.optionalKey(Schema.Boolean),
  taskId: Schema.optionalKey(Schema.NullOr(WorkTask.fields.id)),
  processed: Schema.optionalKey(Schema.Boolean),
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type InboxSubject = typeof InboxSubject.Type;
export const InboxSubjectsPage = Schema.Struct({
  subjects: Schema.Array(InboxSubject),
  nextCursor: Schema.NullOr(Cursor),
});
export const InboxSubjectEntriesInput = Schema.Struct({
  ...InboxPaginationFields,
  subjectId: Schema.NonEmptyString,
});
export const InboxGroupingStatus = Schema.Struct({
  enabled: Schema.Boolean,
  model: Schema.String,
  instanceId: Schema.String,
  subjects: Schema.Int,
  processed: Schema.Int,
  created: Schema.Int,
  reused: Schema.Int,
  excluded: Schema.Int,
  remaining: Schema.Int,
  waitingJev: Schema.Int,
  errors: Schema.Int,
  head: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      sequence: Schema.Int,
      state: Schema.Literals(["waiting_jev", "pending", "processing", "error"]),
      attempts: Schema.Int,
      nextAttemptAt: Schema.String,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});

const SubjectActionFields = {
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  subjectId: InboxSubject.fields.id,
  expectedVersion: NonNegativeInt,
};
export const InboxSubjectActionInput = Schema.Union([
  Schema.Struct({
    ...SubjectActionFields,
    kind: Schema.Literal("create"),
    title: WorkTaskFields.fields.title,
    description: WorkTaskFields.fields.notes,
    projectId: Schema.NullOr(ProjectId),
  }),
  Schema.Struct({
    ...SubjectActionFields,
    kind: Schema.Literal("update"),
    taskId: WorkTask.fields.id,
    taskVersion: NonNegativeInt,
    projectId: Schema.NullOr(ProjectId),
    title: WorkTaskFields.fields.title,
    description: WorkTaskFields.fields.notes,
  }),
  Schema.Struct({
    ...SubjectActionFields,
    kind: Schema.Literal("ignore"),
    ignored: Schema.Boolean,
  }),
]);
export type InboxSubjectActionInput = typeof InboxSubjectActionInput.Type;
export const InboxSubjectActionResult = Schema.Struct({
  subjectId: InboxSubject.fields.id,
  actionVersion: NonNegativeInt,
  ignored: Schema.Boolean,
  taskId: Schema.NullOr(WorkTask.fields.id),
  processed: Schema.optionalKey(Schema.Boolean),
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export class InboxSubjectActionError extends Schema.TaggedError<InboxSubjectActionError>()(
  "InboxSubjectActionError",
  {
    reason: Schema.Literals([
      "storage",
      "validation",
      "conflict",
      "missing",
      "linked",
      "project",
      "limit",
      "closed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "validation":
        return "Vérifiez le titre et la description avant d’enregistrer.";
      case "closed":
        return "Ce sujet est définitivement terminé. Sa tâche ne peut plus être mise à jour depuis l’inbox.";
      case "conflict":
        return "Ce sujet ou cette tâche a changé. Actualisez avant de réessayer.";
      case "missing":
        return "Ce sujet n’est plus disponible.";
      case "linked":
        return "La mise à jour doit cibler la tâche déjà liée à ce sujet.";
      case "project":
        return "Choisissez un projet disponible. Le projet de la tâche cible ne peut pas être changé ici.";
      case "limit":
        return "Les notes ou les sources dépassent la capacité de la tâche. Réduisez le texte ajouté.";
      case "storage":
        return "Impossible d’enregistrer cette décision sur le sujet.";
    }
  }
}
