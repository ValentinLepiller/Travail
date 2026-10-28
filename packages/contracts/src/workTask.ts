import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString, ProjectId, ThreadId } from "./baseSchemas.ts";

export const WorkTaskStatus = Schema.Literals(["todo", "doing", "review", "done"]);
export const WorkTaskFields = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
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
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkTask = typeof WorkTask.Type;
export const WorkTaskSaveInput = Schema.Struct({
  ...WorkTaskFields.fields,
  id: WorkTask.fields.id,
  expectedVersion: NonNegativeInt,
});
export type WorkTaskSaveInput = typeof WorkTaskSaveInput.Type;
export const WorkTaskDeleteInput = Schema.Struct({
  id: WorkTask.fields.id,
  expectedVersion: NonNegativeInt,
});
export type WorkTaskDeleteInput = typeof WorkTaskDeleteInput.Type;
export class WorkTaskError extends Schema.TaggedError<WorkTaskError>()("WorkTaskError", {
  reason: Schema.Literals(["storage", "conflict", "project", "agent"]),
}) {
  override get message(): string {
    switch (this.reason) {
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
