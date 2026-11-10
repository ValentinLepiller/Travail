import {
  AutonomousAgent,
  AutonomousAgentCommand,
  AutonomousAgentError,
  ChefMessage,
  ChefRules,
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
  Tool.make("chef_message", {
    description:
      "Write a short message to Valentin in Chefs, from your current Chef thread. Reuse the same id on retry. A question requiring a reply must also have a precise Requête; this chat never grants approval of a pending action.",
    parameters: Schema.Struct({ id: ChefMessage.fields.id, text: ChefMessage.fields.text }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("chef_rules", {
    description:
      "Update your own Chef's working rules and fallback interval (seconds), preserving project scope, model, human pauses and approvals. Supply the complete mission. Changes apply to subsequent passes, including after restart.",
    parameters: ChefRules,
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
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
      "Create or configure an autonomous agent, pause/resume it, or update memory. Archive a paused agent to remove it from the visible list while preserving history and pending requests; unarchive restores it paused. Archived agents must be restored before resume. New agents start paused. Follow the user's authorized scope.",
    parameters: Schema.Struct({ command: AutonomousAgentCommand }),
    success: Schema.Void,
    failure: Schema.Union([AutonomousAgentError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("work_tasks_list", {
    description:
      "Read all work tasks and their latest versions, including chantier tasks for context. Qualifiers and coordinators may read them to recognize incoming clarifications, but cannot modify attached tasks.",
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
      "Save a native task with optimistic version checking. New and reopened tasks use ready (À démarrer); todo and unqualified have been retired. Saving does not launch an agent. Preserve notes, sources, associations and dependencies. Only ready tasks may launch after explicit authorization and completed prerequisites. Use merged for a verified duplicate with provenance preserved, rejected for a refused task, and review for delivered work awaiting validation. Historical qualifier/coordinator discussions cannot modify chantier tasks; their orchestrator owns those tasks. The old qualificationGroup/reservation workflow is retired.",
    parameters: WorkTaskSaveInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
);
