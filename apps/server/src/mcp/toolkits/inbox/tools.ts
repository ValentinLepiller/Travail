import {
  InboxGroupingStatus,
  InboxSubjectsPage,
  InboxSubjectEntriesInput,
} from "@t3tools/contracts";
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
  Tool.make("inbox_subjects", {
    description:
      "List durable subjects, oldest first; bounded cursor pagination. No tasks or execution.",
    parameters: InboxListInput,
    success: InboxSubjectsPage,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_subject_entries", {
    description: "Read original entries and sources of a subject; bounded pagination.",
    parameters: InboxSubjectEntriesInput,
    success: InboxPage,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_grouping_status", {
    description:
      "Read durable Luna grouping progress, model, creation/reuse counts and head error. No content returned.",
    parameters: Tool.EmptyParams,
    success: InboxGroupingStatus,
    failure: Schema.Union([Subjects.InboxSubjectError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [Subjects.InboxSubjectService, Invocation.McpInvocationContext],
  }).annotate(Tool.Readonly, true),
  Tool.make("inbox_grouping_control", {
    description:
      "Enable or pause durable Luna grouping after Jev, one FIFO entry at a time. Never changes Jev or source messages.",
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
      "Read collected Gmail and Slack messages independently of tasks. Returns up to 20 messages in collection order; pass nextCursor as after for the next page. No qualification or agent is triggered.",
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
