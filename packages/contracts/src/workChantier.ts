import { ChantierV2State } from "./workChantierV2.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const WorkSource = Schema.Struct({
  kind: Schema.Literals(["manual", "slack", "email", "notion", "quote", "meeting", "other"]),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  url: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/^https?:\/\//)),
  ),
});
export type WorkSource = typeof WorkSource.Type;
export const WorkExternalDependency = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  owner: Schema.String.check(Schema.isMaxLength(240)),
  done: Schema.Boolean,
});
export const WorkChantierFields = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  projectId: ProjectId,
  status: Schema.Literals(["draft", "active", "paused", "done"]),
  objective: Schema.String.check(Schema.isMaxLength(10000)),
  scope: Schema.String.check(Schema.isMaxLength(20000)),
  decisions: Schema.String.check(Schema.isMaxLength(20000)),
  targetPeriod: Schema.String.check(Schema.isMaxLength(240)),
  sources: Schema.Array(WorkSource).check(Schema.isMaxLength(50)),
  externalDependencies: Schema.Array(WorkExternalDependency).check(Schema.isMaxLength(100)),
});
export const WorkChantier = Schema.Struct({
  ...WorkChantierFields.fields,
  generation: Schema.optionalKey(Schema.Literals(["legacy", "v2"])),
  v2: Schema.optionalKey(ChantierV2State),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  version: NonNegativeInt,
  orchestratorThreadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkChantier = typeof WorkChantier.Type;
export const WorkChantierReadInput = Schema.Struct({ id: WorkChantier.fields.id });
export const WorkChantierSaveInput = Schema.Struct({
  generation: Schema.optionalKey(Schema.Literals(["legacy", "v2"])),
  ...WorkChantierFields.fields,
  id: WorkChantier.fields.id,
  expectedVersion: NonNegativeInt,
});
export type WorkChantierSaveInput = typeof WorkChantierSaveInput.Type;
export const WorkChantierLaunchInput = Schema.Struct({
  id: WorkChantier.fields.id,
  expectedVersion: NonNegativeInt,
  modelSelection: ModelSelection,
});
export type WorkChantierLaunchInput = typeof WorkChantierLaunchInput.Type;
export const WorkChantierClaimInput = Schema.Struct({
  id: WorkChantier.fields.id,
  expectedVersion: NonNegativeInt,
});
