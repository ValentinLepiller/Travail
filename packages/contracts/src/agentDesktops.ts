import * as Schema from "effect/Schema";

export const AgentDesktopController = Schema.Literals(["agent", "human"]);
export type AgentDesktopController = typeof AgentDesktopController.Type;
export const AgentDesktopApplication = Schema.Literals(["terminal", "message"]);
export type AgentDesktopApplication = typeof AgentDesktopApplication.Type;

export const AgentDesktopStatus = Schema.Struct({
  sessionId: Schema.String,
  ownerId: Schema.String,
  display: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  controller: AgentDesktopController,
  revision: Schema.Number,
  applications: Schema.Number,
});
export type AgentDesktopStatus = typeof AgentDesktopStatus.Type;

export const AgentDesktopWindow = Schema.Struct({ id: Schema.String, title: Schema.String });
export const AgentDesktopSnapshot = Schema.Struct({
  status: AgentDesktopStatus,
  windows: Schema.Array(AgentDesktopWindow),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
export type AgentDesktopSnapshot = typeof AgentDesktopSnapshot.Type;

export const AgentDesktopTarget = Schema.Struct({
  sessionId: Schema.String,
  revision: Schema.Number,
});
export type AgentDesktopTarget = typeof AgentDesktopTarget.Type;
const WindowTarget = { ...AgentDesktopTarget.fields, windowId: Schema.String };
export const AgentDesktopInput = Schema.Union([
  Schema.Struct({
    ...WindowTarget,
    kind: Schema.Literal("click"),
    x: Schema.Number,
    y: Schema.Number,
    button: Schema.optional(Schema.Literals([1, 2, 3])),
  }),
  Schema.Struct({ ...WindowTarget, kind: Schema.Literal("type"), text: Schema.String }),
  Schema.Struct({ ...WindowTarget, kind: Schema.Literal("key"), key: Schema.String }),
]);
export type AgentDesktopInput = typeof AgentDesktopInput.Type;

export class AgentDesktopError extends Schema.TaggedError<AgentDesktopError>()(
  "AgentDesktopError",
  {
    code: Schema.Literals([
      "unavailable",
      "maintenance_active",
      "capacity",
      "not_found",
      "control_conflict",
      "invalid_input",
      "operation_failed",
    ]),
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent desktop ${this.operation}: ${this.code}.`;
  }
}

export const isAgentDesktopError = Schema.is(AgentDesktopError);

export const AgentDesktopLeaseId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export const isAgentDesktopLeaseId = Schema.is(AgentDesktopLeaseId);
export const AgentDesktopLease = Schema.Struct({
  leaseId: AgentDesktopLeaseId,
  status: AgentDesktopStatus,
});
export type AgentDesktopLease = typeof AgentDesktopLease.Type;
export const AgentDesktopHumanAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("take"), target: AgentDesktopTarget }),
  Schema.Struct({ action: Schema.Literal("release"), target: AgentDesktopTarget }),
  Schema.Struct({ action: Schema.Literal("input"), input: AgentDesktopInput }),
  Schema.Struct({ action: Schema.Literal("close"), target: AgentDesktopTarget }),
]);
export type AgentDesktopHumanAction = typeof AgentDesktopHumanAction.Type;
