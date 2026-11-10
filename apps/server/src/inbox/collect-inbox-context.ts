// @effect-diagnostics globalConsole:off -- Standalone read-only connector JSON protocol.
import * as Schema from "effect/Schema";
import { openNativeApps, connectorThread } from "../../../../scripts/connectors/native.ts";
import { callConnector, connectorData } from "../../../../scripts/connectors/adapter.ts";
import { readSourceContext } from "./readSourceContext.ts";
import { InboxContextReadInput } from "./contextSourcePages.ts";
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
  }
  console.log(JSON.stringify(await readSourceContext(source, call)));
} catch {
  console.log(
    JSON.stringify({ status: "unavailable", messages: [], truncated: false, reason: "source" }),
  );
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  client.close();
}
