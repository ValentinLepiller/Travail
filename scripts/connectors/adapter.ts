import { record } from "./native.ts";

const operations = {
  "gmail.profile": "gmail.get_profile",
  "gmail.search": "gmail.search_email_ids",
  "gmail.read": "gmail.read_email",
  "gmail.thread": "gmail.read_email_thread",
  "gmail.drafts": "gmail.list_drafts",
  "gmail.createDraft": "gmail.create_draft",
  "gmail.updateDraft": "gmail.update_draft",
  "gmail.sendDraft": "gmail.send_draft",
  "gmail.send": "gmail.send_email",
  "slack.workspaces": "slack.slack_list_workspaces",
  "slack.search": "slack.slack_search_public",
  "slack.searchAll": "slack.slack_search_public_and_private",
  "slack.channels": "slack.slack_list_user_channels",
  "slack.readChannel": "slack.slack_read_channel",
  "slack.read": "slack.slack_read_thread",
  "slack.file": "slack.slack_read_file",
  "slack.createDraft": "slack.slack_send_message_draft",
  "slack.send": "slack.slack_send_message",
} as const;
const writes = new Set([
  "gmail.createDraft",
  "gmail.updateDraft",
  "gmail.sendDraft",
  "gmail.send",
  "slack.createDraft",
  "slack.send",
]);

function containsHtml(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  const part = record(value);
  if (part.content_disposition === "attachment" || (part.filename && !part.content_id))
    return false;
  return (
    part.mime_type === "text/html" ||
    (Array.isArray(part.parts) && part.parts.some((child) => containsHtml(child, depth + 1)))
  );
}

function boundedLimit(value: unknown) {
  if (value === undefined) return 5;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error(
      "Result limit must be an integer between 1 and 20; paginate with the native connector cursor",
    );
  }
  return value;
}

export function connectorData(result: Record<string, unknown>) {
  if (result.structuredContent != null) return record(result.structuredContent);
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const content = record(block);
    if (content.type === "text" && typeof content.text === "string") {
      try {
        return record(JSON.parse(content.text));
      } catch {
        continue;
      }
    }
  }
  throw new Error("Connector returned no recognized data envelope");
}

/** Authorization is an agent acknowledgment of the human request, never an OAuth grant. */
export function prepareCall(request: unknown, allowWrite = false) {
  const input = record(request);
  const operation = String(input.operation);
  if (!Object.hasOwn(operations, operation))
    throw new Error("Unsupported operation; Teams and personal WhatsApp are not connected");
  if (
    writes.has(operation) &&
    (!allowWrite || typeof input.authorization !== "string" || !input.authorization.trim())
  ) {
    throw new Error(
      "Writing requires --allow-write and the explicit human instruction in authorization",
    );
  }
  const args = { ...record(input.arguments ?? {}) };
  if (operation === "gmail.search" || operation === "gmail.drafts")
    args.max_results = boundedLimit(args.max_results);
  if (operation === "gmail.read" && args.format === undefined) args.format = "metadata";
  if (operation === "slack.workspaces") args.limit = boundedLimit(args.limit);
  if (operation === "slack.channels") {
    args.limit = boundedLimit(args.limit);
    args.types ??= "public_channel";
    args.response_format ??= "ids_only";
  }
  if (
    operation === "slack.search" ||
    operation === "slack.searchAll" ||
    operation === "slack.read" ||
    operation === "slack.readChannel"
  ) {
    args.limit = boundedLimit(args.limit);
    args.response_format ??= "concise";
    if (operation === "slack.search" || operation === "slack.searchAll")
      args.include_context ??= false;
  }
  if (
    (operation === "gmail.createDraft" ||
      operation === "gmail.updateDraft" ||
      operation === "gmail.send") &&
    args.payload != null
  ) {
    if (!containsHtml(args.payload) && input.plainTextRequested !== true) {
      throw new Error(
        "Gmail messages require text/html MIME unless the human requested plain text",
      );
    }
  }
  if ((operation === "gmail.createDraft" || operation === "gmail.send") && args.payload == null)
    throw new Error("An HTML MIME payload is required");
  return { tool: operations[operation as keyof typeof operations], arguments: args };
}

/** Account choices published by Codex alongside the tool schema. */
export async function connectorAccounts(
  rpc: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  tool: string,
) {
  const status = record(
    await rpc("mcpServerStatus/list", { threadId, serverName: "codex_apps", limit: 1 }),
  );
  const servers = Array.isArray(status.data) ? status.data : [];
  const server = servers.map(record).find((entry) => entry.name === "codex_apps");
  const descriptor = record(record(server?.tools ?? {})[tool] ?? {});
  const schema = record(descriptor.inputSchema ?? {});
  const property = record(record(schema.properties ?? {}).link_id ?? {});
  const required = Array.isArray(schema.required) && schema.required.includes("link_id");
  const description = typeof property.description === "string" ? property.description : "";
  const start = description.indexOf("[");
  let entries: unknown = [];
  if (start >= 0) {
    try {
      entries = JSON.parse(description.slice(start));
    } catch {
      /* An unknown schema format must not select an account. */
    }
  }
  const accounts = (Array.isArray(entries) ? entries : []).map(record).flatMap((entry) =>
    typeof entry.link_id === "string" && entry.link_id.trim()
      ? [
          {
            linkId: entry.link_id,
            label: String(
              entry.profile_email ?? entry.profile_name ?? entry.link_name ?? entry.link_id,
            ),
          },
        ]
      : [],
  );
  return { required, accounts };
}

export async function callConnector(
  rpc: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  request: unknown,
  allowWrite = false,
) {
  const call = prepareCall(request, allowWrite);
  if (call.arguments.link_id === undefined) {
    const { required, accounts } = await connectorAccounts(rpc, threadId, call.tool);
    if (required) {
      const account = accounts.length === 1 ? accounts[0] : undefined;
      if (!account)
        throw new Error(
          "Choose the account using arguments.link_id; list accounts with connector CLI status.",
        );
      call.arguments.link_id = account.linkId;
    }
  }
  const result = record(
    await rpc("mcpServer/tool/call", { threadId, server: "codex_apps", ...call }),
  );
  if (result.isError === true)
    throw new Error(
      "Connector tool failed; verify app access and source-system permissions in Codex",
    );
  return result;
}
