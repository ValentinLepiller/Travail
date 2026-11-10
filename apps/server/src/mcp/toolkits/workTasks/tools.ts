import * as ChantierCoordinator from "../../../workTasks/WorkChantierCoordinator.ts";
import { AgentRequest, ChantierApprovalInput, ChantierV2Command } from "@t3tools/contracts";
import {
  WorkChantier,
  WorkChantierReadInput,
  WorkChantierSaveInput,
  WorkChantierClaimInput,
  WorkChantierPlanInput,
  WorkTaskLaunchInput,
} from "@t3tools/contracts";
import * as Agents from "../../../workTasks/WorkTaskAgentService.ts";
import {
  WorkTask,
  WorkTaskError,
  WorkTaskReadInput,
  WorkTaskClaimInput,
  WorkTaskTypesConfig,
  SlackTaskMessage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import * as Collector from "../../../workTasks/SlackTaskCollector.ts";
import { SlackCollectionError } from "../../../workTasks/SlackTaskSource.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [
  Tasks.WorkTaskService,
  Collector.SlackTaskCollector,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
export const WorkTasksToolkit = Toolkit.make(
  Tool.make("work_chantier_v2_request_approval", {
    description:
      "Ask Valentin in Requêtes to approve one exact V2 chantier operation, with its current version and reviewed material. After acceptance apply the same command with approvalRequestId set to requestId. Any scope/version change requires a fresh approval. Does not grant approval itself.",
    parameters: ChantierApprovalInput,
    success: AgentRequest,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [...dependencies, ChantierCoordinator.WorkChantierCoordinator],
  }),
  Tool.make("work_chantier_v2_command", {
    description:
      "Update your V2 chantier dossier/memory, review the latest PR head or record proven completion. Human framing/task/merge/deployment approvals cannot be granted by an agent. Uses expected versions; does not alter legacy chantiers. Two independent head approvals trigger merge, without a third consent. Deployment is separate.",
    parameters: Schema.Struct({ command: ChantierV2Command }),
    success: WorkChantier,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [...dependencies, ChantierCoordinator.WorkChantierCoordinator],
  }),
  Tool.make("work_chantiers_list", {
    description:
      "List native Travail chantiers and their orchestrator discussion IDs. Find the chantier linked to this thread before planning or updating it.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(WorkChantier),
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_chantier_read", {
    description:
      "Read the current chantier objective, scope, decisions, sources, external prerequisites and tasks. Read at every resumption and before changes; use task discussion IDs with t3_thread_read to inspect actual results.",
    parameters: WorkChantierReadInput,
    success: Schema.Struct({
      chantier: WorkChantier,
      tasks: Schema.Array(WorkTask),
      types: WorkTaskTypesConfig,
    }),
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_chantier_save", {
    description:
      "Create or edit durable chantier context using expectedVersion (0 for new). Preserve prior decisions and sources. Does not launch an agent. Use active when the scope is agreed; draft for planning, paused to prevent new task launches, done to close; reopen with active.",
    parameters: WorkChantierSaveInput,
    success: WorkChantier,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }),
  Tool.make("work_chantier_apply_plan", {
    description:
      "Atomically update a chantier and upsert its tasks with optimistic versions. Only supplied tasks change; omitted tasks are preserved. Task IDs may reference each other in this batch. Record decisions/scope and acceptance criteria; preserve associations and sources, use milestone for deferred work. Rejects missing/cross-chantier dependencies and cycles. Requires user authorization for the proposed scope; no agent is launched.",
    parameters: WorkChantierPlanInput,
    success: WorkChantier,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }),
  Tool.make("work_chantier_claim", {
    description:
      "Associate this discussion as the permanent orchestrator of a chantier in the same project. Refuses replacing another discussion. Read first; does not claim execution tasks.",
    parameters: WorkChantierClaimInput,
    success: WorkChantier,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }),
  Tool.make("work_chantier_release", {
    description:
      "Detach only this calling orchestrator discussion from a chantier, preserving all context and tasks; does not stop or delete the thread.",
    parameters: WorkChantierClaimInput,
    success: WorkChantier,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: dependencies,
  }),
  Tool.make("work_task_launch", {
    description:
      "Launch the separate execution discussion for an authorized task in ready (À démarrer). Requires all prerequisites done and an active chantier. Reuses the associated discussion, never launches blocked work. Select a model from orchestrator_capabilities. Read after uncertain results before retrying.",
    parameters: WorkTaskLaunchInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [...dependencies, Agents.WorkTaskAgentService],
  }),
  Tool.make("work_tasks_list", {
    description:
      "List native Travail tasks with IDs, versions, types and associated discussion IDs. Search titles/notes to identify the task the user means; do not guess ambiguous matches. One task supports at most one discussion; one discussion may claim multiple tasks.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(WorkTask),
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_task_read", {
    description:
      "Read a native task with its notes, Slack source messages and configured type prompt before working on it.",
    parameters: WorkTaskReadInput,
    success: Schema.Struct({
      task: WorkTask,
      messages: Schema.Array(SlackTaskMessage),
      types: WorkTaskTypesConfig,
    }),
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("work_task_claim", {
    description:
      "Associate this calling discussion with a native task at the user's request. Refuses a task already assigned to another discussion. Keeps other tasks already assigned to this discussion. No new agent is launched and the status remains manual. A task without a project adopts this discussion's project; a different project or completed/rejected/merged task is refused. Read first and use expectedVersion; on conflict read again. Apply the type prompt to your work together with the user's instructions.",
    parameters: WorkTaskClaimInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("work_task_release", {
    description:
      "Remove only this calling discussion's association from a task. Refuses removing another discussion’s association; keeps task contents and status. Does not stop threads or delete the task. Read first and use expectedVersion.",
    parameters: WorkTaskClaimInput,
    success: WorkTask,
    failure: Schema.Union([WorkTaskError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("slack_tasks_sync", {
    description:
      "Run the deterministic Slack inbox collector now. Reads the shared slack-task-rules.json file and stores messages in the inbox without creating tasks, marking Slack messages read or launching an agent. created counts new inbox entries; appended stays zero. Disabled until configured. The server also runs it every minute.",
    parameters: Tool.EmptyParams,
    success: Collector.SlackTaskSyncResult,
    failure: Schema.Union([SlackCollectionError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("slack_tasks_status", {
    description:
      "Read the Slack inbox collector configuration path, enabled state, activation timestamp and progress. Agents may edit the shared rules file; changes apply at the next collection pass.",
    parameters: Tool.EmptyParams,
    success: Collector.SlackTaskCollectionStatus,
    failure: Schema.Union([SlackCollectionError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
);
