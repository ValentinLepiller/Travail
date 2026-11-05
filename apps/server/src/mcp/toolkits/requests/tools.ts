import {
  AgentRequest,
  AgentRequestCreate,
  AgentRequestUpdate,
  AgentRequestComplete,
  AgentRequestError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Requests from "../../../agentRequests/AgentRequestService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const dependencies = [
  Requests.AgentRequestService,
  Threads.ThreadManagementService,
  Invocation.McpInvocationContext,
];
export const RequestsToolkit = Toolkit.make(
  Tool.make("request_create", {
    description:
      "Send the user a request in the Requêtes inbox, attached automatically to this thread. Use a stable unique id for retries. context and question are short sentences; details is Markdown supporting screenshots, links and Mermaid diagrams. Default to kind approval (Accept/Reject) for any concrete proposal, permission, plan, scope change, fallback or proposed setting; yes/no confirmations use approval even without an action. Reserve kind text for essential missing information requiring a free-form answer (such as a name or description), only when approval of a reasonable proposal cannot suffice. Never use text to ask the user to type yes or confirm. kind approval supports an optional action: agent returns the approval and instruction to you; command runs executable with args in cwd after acceptance (120s limit, no shell unless explicitly supplied). For task qualification proposals, set qualification with decision keep or reject and the real source label (Slack - #channel or Gmail - sender@example.com); question is a concise decision summary without emoji; context is a short sentence summarizing the original message (who announces or requests what), visible before opening details, rather than just a project or channel name. Set sourceTaskId to the exact collected message reference (required in batches; never guess the first task): slack:<workspaceId>:<channelId>:<ts> using the message ts, not threadTs; or gmail:<accountEmail>:<messageId>. Otherwise set source with kind, label, original url, and verbatim text (at most 6000 characters; null if unavailable), optionally author and title, from the integration you read. Do not substitute your summary for source text. A single linked task is resolved automatically when unambiguous. Never include secrets. kind text has action null. Return immediately and continue unrelated work; the response automatically wakes or steers this thread. Do not execute a proposed action before acceptance.",
    parameters: AgentRequestCreate,
    success: AgentRequest,
    failure: Schema.Union([AgentRequestError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("request_update", {
    description:
      "Revise or withdraw your own pending request. Keep the same id after a user asks for changes; expectedVersion prevents stale updates. A revision goes back to the inbox for approval. Accepted requests are immutable. withdraw=true removes a request that is no longer needed. Preserve the source unless changing it: sourceTaskId selects the exact collected message's original task id; source supplies a verbatim excerpt and original URL for other integrations, source=null removes it.",
    parameters: AgentRequestUpdate,
    success: AgentRequest,
    failure: Schema.Union([AgentRequestError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("request_complete", {
    description:
      "Report success or failure after performing an accepted agent action. Include a short summary. This updates the existing archived request; it does not execute anything or wake the agent again.",
    parameters: AgentRequestComplete,
    success: AgentRequest,
    failure: Schema.Union([AgentRequestError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }),
  Tool.make("request_list", {
    description:
      "Read requests created by this thread, including responses, versions and automatic action/delivery results. Responses arrive automatically; do not poll while waiting.",
    parameters: Tool.EmptyParams,
    success: Schema.Array(AgentRequest),
    failure: Schema.Union([AgentRequestError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
);
