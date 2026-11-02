import {
  AutonomousAgent,
  AutonomousAgentCommand,
  AutonomousAgentError,
  OrchestratorMcpFailure,
  WorkTask,
  WorkTaskSaveInput,
  WorkTaskError,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Agents from "../../../autonomousAgents/AutonomousAgentService.ts";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const dependencies = [
  Agents.AutonomousAgentService,
  Tasks.WorkTaskService,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
export const AutonomousAgentsToolkit = Toolkit.make(
  Tool.make("autonomous_agents_list", {
    description:
      "List autonomous agents, their ids, scope and current state. Use ids to address questions.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(AutonomousAgent),
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("autonomous_agent_configure", {
    description:
      "Create or configure an autonomous agent, pause/resume it, or update memory. New agents start paused. Follow the user's authorized scope.",
    parameters: Schema.Struct({ command: AutonomousAgentCommand }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("work_tasks_list", {
    description: "Read work tasks and their latest versions before qualification or updating them.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(WorkTask),
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("autonomous_agent_reply", {
    description:
      "Answer an incoming question in your existing thread without ending your own task.",
    parameters: Schema.Struct({
      id: Schema.Int,
      text: Schema.String.check(Schema.isMaxLength(20000)),
    }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("autonomous_agent_finish", {
    description:
      "Save your complete updated memory, preserving its Personality section. If awaiting a human decision or an agent response, this parks the thread using Snooze and frees the agent for other tasks; the response wakes this SAME thread by priority. Leave unresolved qualification unqualified. Otherwise finish and archive the task. Atomically save your complete updated durable memory before the app archives this thread. Preserve learned project scope and user decisions. Include your result as response for a requesting agent.",
    parameters: Schema.Struct({
      memory: Schema.String.check(Schema.isMaxLength(50000)),
      response: Schema.String.check(Schema.isMaxLength(20000)),
    }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("autonomous_agent_ask", {
    description:
      "Queue a question to another autonomous agent (id). End your turn and wait: its response wakes this SAME thread. Do not launch a new thread. Call autonomous_agent_finish with your updated memory before ending the turn so your thread can snooze until the response. Never create circular chains of requests.",
    parameters: Schema.Struct({
      target: Schema.String,
      text: Schema.String.check(Schema.isMaxLength(20000)),
    }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("work_task_save", {
    description:
      "Update a task with optimistic version checking. Qualifiers must create a Requêtes approval with qualification.decision keep and wait for human acceptance before setting todo (À préparer). The coordinator changes todo to ready (À démarrer) only after rewriting, resolving relevant questions and choosing a suitable type or an explicitly approved no-type exception. A qualifier cannot set ready. Only ready tasks can launch a new agent; launch changes the status to doing. Until accepted, leave the task unqualified. The server rejects todo without this approval for the current task. Use merged for duplicates consolidated into a principal task, preserving source notes and a reference to that principal; rejected is for refused tasks. Preserve supplied fields; uncertain rejection also requires a human Requêtes decision first.",
    parameters: WorkTaskSaveInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
);
