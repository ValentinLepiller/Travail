// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Metadata-only live proof; no sensitive payload logging.
import * as NodeFSP from "node:fs/promises";
import { openNativeApps, record, installedApps, connectorThread } from "./native.ts";
import { callConnector, connectorData, connectorAccounts } from "./adapter.ts";

const client = await openNativeApps();
const proof: Record<string, unknown> = {
  desktopEnvironmentRemoved: true,
  preservedCodexEnvironment: ["CODEX_HOME"],
  writesPerformed: 0,
};
try {
  proof.apps = await installedApps(client.rpc);
  const threadId = await connectorThread(client.rpc);
  const servers = record(
    await client.rpc("mcpServerStatus/list", { threadId, serverName: "codex_apps", limit: 1 }),
  );
  proof.servers = (Array.isArray(servers.data) ? servers.data : [])
    .map(record)
    .map(({ name, httpOrigin, authStatus, runtimeStatus }) => ({
      name,
      httpOrigin,
      authStatus,
      runtimeStatus,
    }));
  const tools = (Array.isArray(servers.data) ? servers.data : [])
    .map(record)
    .flatMap((server) => Object.keys(record(server.tools ?? {})));
  proof.toolCoverage = tools.filter((tool) =>
    /^(gmail\.(search_email_ids|read_email|create_draft|update_draft|send_draft|send_email)|slack\.slack_(search_public|read_thread|send_message_draft|send_message))$/.test(
      tool,
    ),
  );
  const gmailAccounts = await connectorAccounts(client.rpc, threadId, "gmail.search_email_ids");
  const gmailLink = gmailAccounts.accounts[0]?.linkId;
  if (gmailAccounts.required && !gmailLink) throw new Error("No Gmail account published by Codex");
  const gmailAccount = gmailLink ? { link_id: gmailLink } : {};
  const search = await callConnector(client.rpc, threadId, {
    operation: "gmail.search",
    arguments: { ...gmailAccount, query: "newer_than:7d -in:spam -in:trash", max_results: 1 },
  });
  const ids = connectorData(search).message_ids;
  proof.gmailSearch = { success: true, results: Array.isArray(ids) ? ids.length : 0 };
  if (Array.isArray(ids) && typeof ids[0] === "string") {
    const read = await callConnector(client.rpc, threadId, {
      operation: "gmail.read",
      arguments: { ...gmailAccount, message_id: ids[0], format: "minimal" },
    });
    proof.gmailRead = {
      success: true,
      format: "minimal",
      resultPresent: read.structuredContent != null,
    };
  }
  const slackSearch = await callConnector(client.rpc, threadId, {
    operation: "slack.search",
    arguments: {
      filters: "after:2026-10-01",
      natural_language_query: "",
      only_my_channels: true,
      sort: "timestamp",
      limit: 1,
      include_context: false,
    },
  });
  const slack = connectorData(slackSearch);
  // Different connector generations use messages or results; inspect only the known message envelope.
  const entries = Array.isArray(slack.messages)
    ? slack.messages
    : Array.isArray(slack.results)
      ? slack.results
      : [];
  proof.slackSearch = { success: true, results: entries.length, resultKeys: Object.keys(slack) };
  if (typeof slack.results === "string") {
    const link = /https:\/\/[^\s<"\\]*slack\.com\/archives\/([A-Z0-9]+)\/p([0-9]+)/.exec(
      slack.results,
    );
    proof.slackSearch = { success: true, responseReceived: true, requestedLimit: 1 };
    if (link?.[1] && link[2]) {
      const ts = `${link[2].slice(0, -6)}.${link[2].slice(-6)}`;
      await callConnector(client.rpc, threadId, {
        operation: "slack.read",
        arguments: { channel_id: link[1], message_ts: ts, limit: 1 },
      });
      proof.slackRead = { success: true, limit: 1 };
    }
  }
  if (entries[0]) {
    const entry = record(entries[0]);
    const channel =
      typeof entry.channel === "object" && entry.channel
        ? record(entry.channel).id
        : entry.channel_id;
    const timestamp = entry.ts ?? entry.message_ts;
    if (typeof channel === "string" && typeof timestamp === "string") {
      await callConnector(client.rpc, threadId, {
        operation: "slack.read",
        arguments: { channel_id: channel, message_ts: timestamp, limit: 1 },
      });
      proof.slackRead = { success: true, limit: 1 };
    } else
      proof.slackRead = {
        success: false,
        reason: "Search result does not expose a recognized channel/timestamp envelope",
      };
  }
  if (!record(proof.slackRead ?? {}).success) {
    const channels = connectorData(
      await callConnector(client.rpc, threadId, {
        operation: "slack.channels",
        arguments: { limit: 1, types: "public_channel", response_format: "ids_only" },
      }),
    );
    const ids = channels.channel_ids ?? channels.channels;
    proof.slackChannels = {
      resultKeys: Object.keys(channels),
      resultTypes: Object.fromEntries(
        Object.entries(channels).map(([key, value]) => [
          key,
          Array.isArray(value) ? "array" : typeof value,
        ]),
      ),
    };
    const first = Array.isArray(ids) ? ids[0] : undefined;
    const channel =
      typeof first === "string"
        ? first
        : first
          ? record(first).id
          : typeof channels.result === "string"
            ? /\bC[A-Z0-9]{8,}\b/.exec(channels.result)?.[0]
            : undefined;
    if (typeof channel === "string") {
      await callConnector(client.rpc, threadId, {
        operation: "slack.readChannel",
        arguments: { channel_id: channel, limit: 1 },
      });
      proof.slackRead = { success: true, operation: "read_channel", limit: 1 };
    }
  }
} catch (error) {
  proof.error = error instanceof Error ? error.message : "Native connector probe failed";
  process.exitCode = 1;
} finally {
  client.close();
  await NodeFSP.mkdir(".logs/harness/connectors", { recursive: true });
  await NodeFSP.writeFile(
    ".logs/harness/connectors/live-proof.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof, null, 2));
}
