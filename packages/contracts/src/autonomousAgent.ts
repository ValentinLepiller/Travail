import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const AgentId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/));
export const AutonomousAgentConfig = Schema.Struct({
  id: AgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  mission: TrimmedNonEmptyString.check(Schema.isMaxLength(20000)),
  projectId: Schema.NullOr(ProjectId),
  modelSelection: ModelSelection,
  intervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 86400 })),
  trigger: Schema.Literals(["interval", "unqualified", "todo"]),
  dailySchedule: Schema.optionalKey(
    Schema.Struct({
      timeOfDay: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
      timeZone: Schema.String.check(
        Schema.makeFilter((value: string) => {
          try {
            return (
              new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone.length >
              0
            );
          } catch {
            return false;
          }
        }),
      ),
    }),
  ),
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 4000 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 4000 })),
});
export type AutonomousAgentConfig = typeof AutonomousAgentConfig.Type;
export const AutonomousAgent = Schema.Struct({
  ...AutonomousAgentConfig.fields,
  paused: Schema.Boolean,
  currentThreadId: Schema.NullOr(ThreadId),
  status: Schema.Literals(["idle", "working", "paused", "blocked", "finishing"]),
  error: Schema.NullOr(Schema.String),
  nextRunAt: Schema.Number,
});
export type AutonomousAgent = typeof AutonomousAgent.Type;
export const AutonomousAgentRun = Schema.Struct({
  threadId: ThreadId,
  agentId: AgentId,
  title: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  waitingFor: Schema.NullOr(Schema.Literals(["human", "agent"])),
});
export const AutonomousAgentDetail = Schema.Struct({
  memory: Schema.String,
  memoryPath: Schema.String,
  history: Schema.Array(AutonomousAgentRun),
  pending: Schema.Int,
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, role: Schema.String, text: Schema.String }),
  ),
});
export const AutonomousAgentCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("save"), config: AutonomousAgentConfig }),
  Schema.Struct({ type: Schema.Literal("export"), id: AgentId, threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("pause"), id: AgentId }),
  Schema.Struct({ type: Schema.Literal("resume"), id: AgentId }),
  Schema.Struct({
    type: Schema.Literal("memory"),
    id: AgentId,
    memory: Schema.String.check(Schema.isMaxLength(50000)),
  }),
]);
export type AutonomousAgentCommand = typeof AutonomousAgentCommand.Type;
export const AutonomousAgentRead = Schema.Struct({
  id: AgentId,
  threadId: Schema.optional(ThreadId),
});
export class AutonomousAgentError extends Schema.TaggedError<AutonomousAgentError>()(
  "AutonomousAgentError",
  { message: Schema.String },
) {}

export type AutonomousAgentRead = typeof AutonomousAgentRead.Type;
export type AutonomousAgentDetail = typeof AutonomousAgentDetail.Type;
