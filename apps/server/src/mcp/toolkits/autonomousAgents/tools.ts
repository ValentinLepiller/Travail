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
      "Update a task with optimistic version checking. The Qualifier and Coordinator only modify tasks without chantierId. They may read chantier tasks and sources to recognize an incoming clarification about an unfinished lot and pass it to its orchestrator. Keep the source card separate; after confirmed delivery the coordinator sets only that source to review pending integration, never ready or merged merely for delivery. They cannot edit, merge, attach, detach, claim or launch chantier tasks; those belong to the chantier orchestrator. Qualifiers process a reserved batch of up to 20 cards from one probable project per session, split by concrete request. Reserve additional cards with work_qualification_reserve before editing. They decide autonomously on each reserved task: set todo (À préparer) for relevant requests, or rejected with a reason for clearly irrelevant ones, without systematic Requêtes approval. When uncertain, keep todo with notes for the coordinator and leave projectId null if unknown; ask the human only for indispensable blockers that cannot be handed to the coordinator. Respect existing human decisions. A qualifier cannot edit tasks outside its reservations or set ready. Save each result progressively; on resumption read current statuses and continue only unqualified cards. Before qualification, inspect other unqualified cards and read their sources to find the exact same request. To consolidate the exact same request atomically into any reserved principal task, pass qualificationGroup: [{id, expectedVersion}] and a synthesized title/notes on that task. Sources remain merged and their messages are included in reads of the principal via mergedTaskIds. A shared conversation or theme alone does not justify grouping; preserve distinct requests. Conflicting, already qualified, associated, or cards reserved by another session cannot be absorbed. The coordinator changes todo to ready (À démarrer) only after rewriting, resolving relevant questions and choosing a suitable type or an explicitly approved no-type exception. Only ready tasks can launch a new agent; launch changes the status to doing. Use merged for duplicates consolidated into a principal task, preserving source notes and a reference to that principal; rejected is for refused tasks. Preserve supplied fields.",
    parameters: WorkTaskSaveInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
);
