import { ChatImageAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import { WorkSource, WorkChantierSaveInput } from "./workChantier.ts";
import { ModelSelection } from "./modelSelection.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, ProjectId, ThreadId } from "./baseSchemas.ts";

export const WorkTaskStatus = Schema.Literals([
  "unqualified",
  "todo",
  "ready",
  "doing",
  "review",
  "done",
  "rejected",
  "merged",
]);
export function isClosedWorkTaskStatus(status: typeof WorkTaskStatus.Type) {
  return status === "done" || status === "rejected" || status === "merged";
}

const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{1,20}$/));
const SlackTimestamp = Schema.String.check(Schema.isPattern(/^\d{10,16}\.\d{6}$/));
export const SlackTaskMessage = Schema.Struct({
  workspaceId: SlackId,
  channelId: SlackId,
  channelName: Schema.String,
  ts: SlackTimestamp,
  threadTs: SlackTimestamp,
  authorId: Schema.String,
  authorName: Schema.optionalKey(Schema.String),
  text: Schema.String.check(Schema.isMaxLength(100_000)),
});
export type SlackTaskMessage = typeof SlackTaskMessage.Type;
export const WorkTaskType = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  prompt: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type WorkTaskType = typeof WorkTaskType.Type;
export const WorkTaskTypesConfig = Schema.Struct({
  version: NonNegativeInt,
  types: Schema.Array(WorkTaskType),
});
export type WorkTaskTypesConfig = typeof WorkTaskTypesConfig.Type;
export const WorkTaskFields = Schema.Struct({
  automationMode: Schema.optionalKey(Schema.Literal("manual")),
  inboxSubjectIds: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
  ),
  mergedTaskIds: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
  ),
  chantierId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  sources: Schema.optionalKey(Schema.Array(WorkSource).check(Schema.isMaxLength(50))),
  dependsOn: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100))),
  externalDependsOn: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  ),
  milestone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(240))),
  acceptanceCriteria: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10000))),
  typeId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  attachments: Schema.optionalKey(
    Schema.Array(ChatImageAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  notes: Schema.String.check(Schema.isMaxLength(20_000)),
  status: WorkTaskStatus,
  projectId: Schema.NullOr(ProjectId),
  agentThreadId: Schema.NullOr(ThreadId),
  dueDate: Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isCalendarDate(value), {
        expected: "a calendar date (YYYY-MM-DD)",
      }),
    ),
  ),
});
export const WorkTask = Schema.Struct({
  ...WorkTaskFields.fields,
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  version: NonNegativeInt,
  qualifiedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkTask = typeof WorkTask.Type;
export const WorkTaskReadInput = Schema.Struct({ id: WorkTask.fields.id });
export const WorkTaskClaimInput = Schema.Struct({
  id: WorkTask.fields.id,
  expectedVersion: NonNegativeInt,
});
export type WorkTaskClaimInput = typeof WorkTaskClaimInput.Type;

export const WorkQualificationReserveInput = Schema.Struct({
  tasks: Schema.Array(WorkTaskClaimInput).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type WorkQualificationReserveInput = typeof WorkQualificationReserveInput.Type;

export const WorkTaskMessagesInput = Schema.Struct({ id: WorkTask.fields.id });
export const WorkTaskSaveInput = Schema.Struct({
  qualificationGroup: Schema.optionalKey(
    Schema.Array(WorkTaskClaimInput).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
  ...WorkTaskFields.fields,
  id: WorkTask.fields.id,
  expectedVersion: NonNegativeInt,
});
export type WorkTaskSaveInput = typeof WorkTaskSaveInput.Type;
export const WorkTaskDeleteInput = Schema.Struct({
  id: WorkTask.fields.id,
  expectedVersion: NonNegativeInt,
});
export const WorkTaskLaunchInput = Schema.Struct({
  ...WorkTaskDeleteInput.fields,
  modelSelection: ModelSelection,
});
export type WorkTaskLaunchInput = typeof WorkTaskLaunchInput.Type;
export type WorkTaskDeleteInput = typeof WorkTaskDeleteInput.Type;
export const WorkChantierPlanInput = Schema.Struct({
  chantier: WorkChantierSaveInput,
  tasks: Schema.Array(WorkTaskSaveInput).check(Schema.isMaxLength(200)),
});
export type WorkChantierPlanInput = typeof WorkChantierPlanInput.Type;
export class WorkTaskError extends Schema.TaggedError<WorkTaskError>()("WorkTaskError", {
  reason: Schema.Literals([
    "storage",
    "conflict",
    "project",
    "agent",
    "preparation",
    "dependencies",
    "cycle",
    "referenced",
    "chantierScope",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "chantierScope":
        return "Les tâches des chantiers sont gérées par leur orchestrateur. Le Qualifieur et le Coordinateur interviennent uniquement sur les tâches sans chantier.";
      case "dependencies":
        return "Les prérequis doivent appartenir au même chantier et être terminés avant de démarrer ou terminer cette tâche.";
      case "cycle":
        return "Ces dépendances créent une boucle. Une tâche ne peut pas dépendre d’elle-même, même indirectement.";
      case "referenced":
        return "Cette tâche est un prérequis. Retire ses dépendances avant de la supprimer ou de changer son cadre.";
      case "preparation":
        return "Cette tâche doit être préparée et passée à À démarrer avant de lancer un agent.";
      case "conflict":
        return "Cette tâche a changé. Actualise la liste avant de réessayer.";
      case "project":
        return "Le projet choisi n’est plus disponible.";
      case "agent":
        return "L’agent choisi n’est plus disponible dans ce projet.";
      case "storage":
        return "Impossible d’enregistrer ou de lire les tâches.";
    }
  }
}

function isCalendarDate(value: string): boolean {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

/** A closed/rejected task does not satisfy a dependency; only delivered work does. */
export function workTaskBlockers(
  task: Pick<WorkTask, "dependsOn" | "externalDependsOn">,
  tasks: ReadonlyArray<Pick<WorkTask, "id" | "title" | "status">>,
  external: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly done: boolean;
  }> = [],
) {
  return [
    ...(task.dependsOn ?? []).flatMap((id) => {
      const dependency = tasks.find((item) => item.id === id);
      return dependency?.status === "done"
        ? []
        : [dependency?.title ?? `Tâche indisponible (${id})`];
    }),
    ...(task.externalDependsOn ?? []).flatMap((id) => {
      const dependency = external.find((item) => item.id === id);
      return dependency?.done ? [] : [dependency?.title ?? `Attente externe indisponible (${id})`];
    }),
  ];
}

export function workTaskSources(task: Pick<WorkTask, "id" | "sources">) {
  if (task.sources?.length) return task.sources;
  const kind = task.id.startsWith("slack:")
    ? "slack"
    : task.id.startsWith("gmail:")
      ? "email"
      : "manual";
  return [
    {
      kind,
      label: kind === "slack" ? "Slack" : kind === "email" ? "Email" : "Saisie manuelle",
      url: null,
    },
  ] as const;
}
