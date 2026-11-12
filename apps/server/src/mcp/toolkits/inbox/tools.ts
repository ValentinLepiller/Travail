import {
  InboxGroupingStatus,
  InboxSubjectsPage,
  InboxSubjectEntriesInput,
} from "@t3tools/contracts";
import {
  ChefDossierDetail,
  ChefDossierReplyInput,
  ChefDossiersPage,
  ChefError,
  ChefMemoryPage,
  ChefPageInput,
  ChefReadInput,
  ChefSettings,
  ChefStatus,
} from "@t3tools/contracts";
import * as Chef from "../../../globalChef/GlobalChefService.ts";
import * as Subjects from "../../../inbox/InboxSubjectService.ts";
import * as Qualifications from "../../../inbox/InboxQualificationService.ts";
import { InboxQualificationControl, InboxQualificationStatus } from "@t3tools/contracts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { InboxContextBackfillInput, InboxContextBackfillResult } from "@t3tools/contracts";
import * as Contexts from "../../../inbox/InboxContextService.ts";
import {
  InboxListInput,
  InboxReadInput,
  InboxPage,
  InboxMessage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Inbox from "../../../inbox/MessageInbox.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [Inbox.MessageInbox, Invocation.McpInvocationContext];
export const InboxToolkit = Toolkit.make(
  Tool.make("chef_status", {
    description:
      "Read global Chef settings and progress. Waiting dossiers never block unrelated subjects. No action or model is triggered.",
    parameters: Tool.EmptyParams,
    success: ChefStatus,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Chef.GlobalChefService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("chef_dossiers", {
    description:
      "List global Chef dossiers in bounded pages, newest first. archived=true reads completed/closed dossiers.",
    parameters: ChefPageInput,
    success: ChefDossiersPage,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Chef.GlobalChefService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("chef_dossier_read", {
    description:
      "Read a Chef dossier conversation, distinct from execution-agent threads. before pages through older messages. Never resumes an agent.",
    parameters: ChefReadInput,
    success: ChefDossierDetail,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Chef.GlobalChefService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("chef_memory", {
    description:
      "Read the Chef's human-approved memory phrases and their scopes in bounded pages. No memory writes are exposed to agents.",
    parameters: ChefPageInput,
    success: ChefMemoryPage,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Chef.GlobalChefService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("chef_control", {
    description:
      "Configure or pause the global Chef's subject-decision worker. It consumes Luna-ready subjects, preserves independent waiting dossiers and asks approval for unknown behavior. Does not grant rules or launch execution agents.",
    parameters: ChefSettings,
    success: ChefStatus,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Chef.GlobalChefService,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  }),
  Tool.make("chef_dossier_reply", {
    description:
      "Reply to the global Chef after receiving a dossier handoff. Only its designated active project/chantier Chef may reply. A reply supplies context and never grants new permissions or writes memory. Use a stable messageId.",
    parameters: ChefDossierReplyInput,
    success: Schema.Void,
    failure: Schema.Union([ChefError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Chef.GlobalChefService,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  }),
  Tool.make("inbox_subjects", {
    description:
      "List durable subjects, oldest first by default; order=desc shows newest first. Optional processed=true selects subjects whose current entries were handled or that are permanently closed; false selects pending, including new entries on a task-linked subject. Omitted includes all. closedAt marks final closure after task completion. context is Luna's project/chantier/task suggestion, distinct from taskId, the task actually linked by a human. Bounded cursor pagination. No tasks or execution.",
    parameters: InboxListInput,
    success: InboxSubjectsPage,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_subject_entries", {
    description:
      "Read original entries and sources of a subject; oldest first by default, order=desc for newest first. Bounded pagination.",
    parameters: InboxSubjectEntriesInput,
    success: InboxPage,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_grouping_status", {
    description:
      "Read durable Luna grouping and subject context progress, model, creation/reuse counts and errors. No content returned.",
    parameters: Tool.EmptyParams,
    success: InboxGroupingStatus,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_grouping_control", {
    description:
      "Enable or pause durable Luna grouping after Jev and context assignment for open subjects, sharing one model lease. Enabling retries failed contexts without reclassifying successful ones. Grouping remains FIFO. Never changes Jev, source messages or tasks.",
    parameters: InboxQualificationControl,
    success: InboxGroupingStatus,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Subjects.InboxSubjectService,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  }),

  Tool.make("inbox_qualification_status", {
    description:
      "Read durable Jev FIFO progress, head, errors, categories and token usage. La catégorie attribuée par Jev est une indication utile, mais elle peut être erronée ; réévalue l’entrée à partir de son contenu et de son contexte.",
    parameters: Tool.EmptyParams,
    success: InboxQualificationStatus,
    failure: Schema.Union([Qualifications.InboxQualificationError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Qualifications.InboxQualificationService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_qualification_control", {
    description:
      "Enable or pause the durable Jev FIFO worker. One entry at a time, oldest first; errors retain the head with backoff. Resume does not requalify completed entries. Creates no tasks or agents; never writes to Gmail/Slack.",
    parameters: InboxQualificationControl,
    success: InboxQualificationStatus,
    failure: Schema.Union([Qualifications.InboxQualificationError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Qualifications.InboxQualificationService,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  }),
  Tool.make("inbox_context_backfill", {
    description:
      "Enrich existing inbox entries with prior source messages only. Paged durable pass over the inbox snapshot at first call; repeat until remaining=0. Default 3 entries, maximum 5 per call. Idempotent across interruptions; existing version-1 contexts are counted as already processed. withContext counts only entries updated in this pass with real predecessors (never merely reviewed entries), empty means successful empty context, failed means unavailable or partial without predecessors; partial is an overlapping incomplete count. Never creates messages, tasks or qualifications; never changes source messages. A completed pass returns the same report. After completion, retryUnavailableIds explicitly retries up to 5 unavailable entries in the original snapshot, in place; successful contexts and the original cursor are preserved.",
    parameters: InboxContextBackfillInput,
    success: InboxContextBackfillResult,
    failure: Schema.Union([Contexts.InboxContextError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Contexts.InboxContextService,
      Invocation.McpInvocationContext,
      Threads.ThreadManagementService,
    ],
  }),
  Tool.make("inbox_list", {
    description:
      "Read collected Gmail and Slack messages independently of tasks. Returns up to 20 messages in collection order, oldest first by default; order=desc shows newest first. Optional processed=true selects entries included in a subject or classified no_action; false selects pending, omitted includes all. Pass nextCursor as after and retain the same order and filter for the next page. No qualification or agent is triggered.",
    parameters: InboxListInput,
    success: InboxPage,
    failure: Schema.Union([Inbox.InboxStorageError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_read", {
    description:
      "Read one stored inbox message by its exact id from inbox_list, with original content, source identity, metadata and link. Does not access or change the source message.",
    parameters: InboxReadInput,
    success: InboxMessage,
    failure: Schema.Union([
      Inbox.InboxStorageError,
      Inbox.InboxMessageNotFound,
      OrchestratorMcpFailure,
    ]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
);
