// @effect-diagnostics globalConsole:off -- Standalone read-only connector JSON protocol.
import { InboxSource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { openNativeApps, connectorThread } from "../../../../scripts/connectors/native.ts";
import { callConnector, connectorData } from "../../../../scripts/connectors/adapter.ts";
import { selectContext } from "./contextMessages.ts";
import {
  InboxContextReadInput,
  parseGmailContext,
  parseSlackContext,
} from "./contextSourcePages.ts";
let raw = "";
for await (const chunk of process.stdin) {
  raw += String(chunk);
  if (raw.length > 150_000) throw new Error("Context input too large");
}
const { source, linkId } = Schema.decodeSync(Schema.fromJsonString(InboxContextReadInput))(raw);
const client = await openNativeApps();
const stop = () => client.close();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const recovered: Array<typeof InboxSource.Type> = [];
try {
  const threadId = await connectorThread(client.rpc);
  const call = async (
    operation:
      | "gmail.profile"
      | "gmail.thread"
      | "slack.workspaces"
      | "slack.read"
      | "slack.readChannel",
    args: Record<string, unknown>,
  ) =>
    connectorData(
      await callConnector(client.rpc, threadId, {
        operation,
        arguments: { ...args, ...(linkId ? { link_id: linkId } : {}) },
      }),
    );
  if (source.kind === "gmail") {
    const profile = Schema.decodeUnknownSync(Schema.Struct({ email: Schema.String }))(
      await call("gmail.profile", {}),
    );
    if (profile.email.toLowerCase() !== source.message.accountEmail.toLowerCase())
      throw new Error("Wrong account");
    const page = parseGmailContext(
      await call("gmail.thread", { thread_id: source.message.threadId, max_messages: 100 }),
      source.message,
    );
    const context = selectContext(source, page.sources, page.incomplete);
    console.log(JSON.stringify({ ...context, truncated: context.truncated || page.truncated }));
  } else {
    const workspaces = Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Literal(true),
        teams: Schema.Array(Schema.Struct({ id: Schema.String })),
        response_metadata: Schema.Struct({ next_cursor: Schema.String }),
      }),
    )(await call("slack.workspaces", { limit: 20, include_icon: false }));
    if (
      workspaces.teams.length !== 1 ||
      workspaces.teams[0]?.id !== source.message.workspaceId ||
      workspaces.response_metadata.next_cursor
    )
      throw new Error("Wrong workspace");
    const threaded = source.message.threadTs !== source.message.ts;
    let cursor: string | null = null;
    const sources = recovered;
    for (let n = 0; n < (threaded ? 3 : 1); n++) {
      const page = parseSlackContext(
        await call(threaded ? "slack.read" : "slack.readChannel", {
          channel_id: source.message.channelId,
          ...(threaded ? { message_ts: source.message.threadTs } : {}),
          latest: source.message.ts,
          limit: 20,
          response_format: "detailed",
          ...(cursor ? { cursor } : {}),
        }),
        source.message,
        threaded,
      );
      sources.push(...page.sources);
      if (page.nextCursor !== null && page.nextCursor === cursor)
        throw new Error("Pagination stalled");
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    // History is newest first: later pages are older and cannot change the last five predecessors.
    let context = selectContext(source, sources, threaded && cursor !== null);
    if (!threaded && cursor !== null) {
      context = {
        ...context,
        truncated: true,
        ...(context.messages.length < 5
          ? { status: "partial" as const, reason: "limit" as const }
          : {}),
      };
    }
    console.log(JSON.stringify(context));
  }
} catch {
  const result = recovered.length
    ? { ...selectContext(source, recovered, true), reason: "source" }
    : { status: "unavailable", messages: [], truncated: false, reason: "source" };
  console.log(JSON.stringify(result));
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  client.close();
}
