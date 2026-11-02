// @effect-diagnostics globalConsole:off -- Standalone connector process; stdout is its JSON protocol.
import * as Schema from "effect/Schema";
import { openNativeApps, connectorThread } from "../../../scripts/connectors/native.ts";
import { callConnector, connectorData } from "../../../scripts/connectors/adapter.ts";
import { SlackCollectionInput } from "../src/workTasks/slackTaskRules.ts";
import { parseSlackSearchPage } from "../src/workTasks/slackSearchPage.ts";

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 16_000) throw new Error("Collection input too large");
}
const request = Schema.decodeSync(Schema.fromJsonString(SlackCollectionInput))(input);
const client = await openNativeApps();
const stop = () => client.close();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const threadId = await connectorThread(client.rpc);
  const account = request.linkId ? { link_id: request.linkId } : {};
  const workspaces = connectorData(
    await callConnector(client.rpc, threadId, {
      operation: "slack.workspaces",
      arguments: { ...account, limit: 20, include_icon: false },
    }),
  );
  const workspace = Schema.decodeUnknownSync(
    Schema.Struct({
      ok: Schema.Literal(true),
      teams: Schema.Array(Schema.Struct({ id: Schema.String })),
      response_metadata: Schema.Struct({ next_cursor: Schema.String }),
    }),
  )(workspaces);
  // Search has no workspace argument. Never attribute a mixed workspace result
  // to one account just because its permalink uses the same channel format.
  if (
    workspace.teams.length !== 1 ||
    workspace.teams[0]?.id !== request.workspaceId ||
    workspace.response_metadata.next_cursor
  ) {
    throw new Error("Select a connector account containing exactly the configured workspace");
  }
  const result = connectorData(
    await callConnector(client.rpc, threadId, {
      operation: "slack.searchAll",
      arguments: {
        ...account,
        filters: "-from:me",
        after: request.after,
        before: request.before,
        ...(request.cursor ? { cursor: request.cursor } : {}),
        content_types: "messages",
        only_my_channels: true,
        include_bots: true,
        include_context: false,
        response_format: "detailed",
        sort: "timestamp",
        sort_dir: "asc",
        limit: 20,
      },
    }),
  );
  console.log(JSON.stringify(parseSlackSearchPage(result, request.workspaceId)));
} catch {
  // No message bodies, credentials, or connector errors in background logs.
  console.error(
    "Slack collection failed: check the account, permissions and connector response format.",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  client.close();
}
