import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewAnnotationPayloadSchema } from "./ipc.ts";

const Text = Schema.String.check(Schema.isMaxLength(20000));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const Head = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
const Url = Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/^https?:\/\//));
export const ChantierPrototype = Schema.Struct({
  status: Schema.Literals(["pending", "ready", "skipped"]),
  url: Schema.NullOr(Url),
  codeReference: Schema.String.check(Schema.isMaxLength(2000)),
  notes: Text,
  annotations: Schema.Array(
    Schema.Struct({
      id: Id,
      target: Text,
      text: Text,
      capture: Schema.optionalKey(
        PreviewAnnotationPayloadSchema.check(
          // Dossiers retain selectors, regions, ink and style changes without inline image data.
          Schema.makeFilter(
            (capture) => capture.screenshot === null && JSON.stringify(capture).length <= 100000,
          ),
        ),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
});
export const ChantierStage = Schema.Struct({ id: Id, title: Id, criteria: Text });
export const ChantierTaskReview = Schema.Struct({
  taskId: Id,
  approvedDefinition: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["code", "other"]),
  pmReference: Schema.String.check(Schema.isMaxLength(2000)),
  pullRequestUrl: Schema.NullOr(Url),
  head: Schema.NullOr(Head),
  humanHead: Schema.NullOr(Head),
  chefHead: Schema.NullOr(Head),
  retainedHumanApproval: Text,
  mergedHead: Schema.NullOr(Head),
  completionEvidence: Text,
  deployment: Schema.NullOr(
    Schema.Struct({ environment: Id, head: Head, approved: Schema.Boolean, evidence: Text }),
  ),
});
export const ChantierV2State = Schema.Struct({
  chefAgentId: Id,
  framingApproved: Schema.Boolean,
  completionCriteria: Text,
  interfaceExpected: Schema.Boolean,
  specifications: Text,
  prototype: ChantierPrototype,
  stages: Schema.Array(ChantierStage).check(Schema.isMaxLength(100)),
  memory: Text,
  finalReview: Text,
  stopped: Schema.Boolean,
  reviews: Schema.Array(ChantierTaskReview).check(Schema.isMaxLength(1000)),
});
export type ChantierV2State = typeof ChantierV2State.Type;
export const ChantierProjectPolicy = Schema.Struct({
  projectId: ProjectId,
  expectedVersion: NonNegativeInt,
  maxParallel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  intervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 86400 })),
  trackingHabits: Text,
  sourceRules: Text,
  deploymentEnvironments: Schema.Array(Id).check(Schema.isMaxLength(20)),
  delegations: Text,
});
export type ChantierProjectPolicy = typeof ChantierProjectPolicy.Type;
const Identity = {
  id: Id,
  expectedVersion: NonNegativeInt,
  approvalRequestId: Schema.optionalKey(Id),
};
const TaskIdentity = { ...Identity, taskId: Id, expectedTaskVersion: NonNegativeInt };
export const ChantierV2Command = Schema.Union([
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("dossier"),
    completionCriteria: Text,
    interfaceExpected: Schema.Boolean,
    specifications: Text,
    prototype: ChantierPrototype,
    stages: Schema.Array(ChantierStage).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({ ...Identity, type: Schema.Literal("memory"), memory: Text, finalReview: Text }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["approveFraming", "pause", "resume", "stop", "close", "reopen"]),
  }),
  Schema.Struct({
    ...TaskIdentity,
    type: Schema.Literal("approveTask"),
    kind: Schema.Literals(["code", "other"]),
    pmReference: Schema.String.check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal("pullRequest"), url: Url, head: Head }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal("humanReview"), approved: Schema.Boolean }),
  Schema.Struct({
    ...TaskIdentity,
    type: Schema.Literal("chefReview"),
    approved: Schema.Boolean,
    retainHumanApproval: Schema.Boolean,
    justification: Text,
  }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal("merged"), head: Head }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal("completeTask"), evidence: Text }),
  Schema.Struct({ ...TaskIdentity, type: Schema.Literal("deploymentGo"), environment: Id }),
  Schema.Struct({
    ...TaskIdentity,
    type: Schema.Literal("deploymentResult"),
    environment: Id,
    head: Head,
    evidence: Text,
  }),
]);
export type ChantierV2Command = typeof ChantierV2Command.Type;
export const ChantierNotifyInput = Schema.Struct({
  id: Id,
  generation: Schema.Literals(["legacy", "v2"]),
  notificationId: Id,
  subjectId: Schema.optionalKey(Id),
  sourceCursor: Schema.optionalKey(NonNegativeInt),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20000)),
});
export type ChantierNotifyInput = typeof ChantierNotifyInput.Type;

export const ChantierApprovalInput = Schema.Struct({ requestId: Id, command: ChantierV2Command });
export type ChantierApprovalInput = typeof ChantierApprovalInput.Type;
export const ChantierNotifySubjectInput = Schema.Struct({
  id: Id,
  generation: Schema.Literals(["legacy", "v2"]),
  subjectId: Id,
  expectedEntries: NonNegativeInt,
});
export type ChantierNotifySubjectInput = typeof ChantierNotifySubjectInput.Type;
