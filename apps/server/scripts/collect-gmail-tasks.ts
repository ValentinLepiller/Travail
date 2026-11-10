// @effect-diagnostics globalConsole:off -- Standalone connector process; stdout is its JSON protocol.
import * as Schema from "effect/Schema";
import { openNativeApps, connectorThread } from "../../../scripts/connectors/native.ts";
import { callConnector, connectorData } from "../../../scripts/connectors/adapter.ts";
import { GmailCollectionInput, acceptsGmailMessage } from "../src/workTasks/gmailTaskRules.ts";
import { collectContext, type ContextConnectorCall } from "../src/inbox/readSourceContext.ts";
import { decodeGmailSearch, parseGmailMessage } from "../src/workTasks/gmailSearchPage.ts";
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 1_000_000) throw new Error("Collection input too large");
}
const request = Schema.decodeSync(Schema.fromJsonString(GmailCollectionInput))(input);
const client = await openNativeApps();
const stop = () => client.close();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let stage = "profile";
try {
  const threadId = await connectorThread(client.rpc);
  const account = request.linkId ? { link_id: request.linkId } : {};
  const call = async (
    operation:
      | "gmail.profile"
      | "gmail.search"
      | "gmail.read"
      | Parameters<ContextConnectorCall>[0],
    args: Record<string, unknown>,
  ) =>
    connectorData(
      await callConnector(client.rpc, threadId, { operation, arguments: { ...account, ...args } }),
    );
  const profile = Schema.decodeUnknownSync(Schema.Struct({ email: Schema.String }))(
    await call("gmail.profile", {}),
  );
  if (profile.email.toLowerCase() !== request.accountEmail.toLowerCase())
    throw new Error("Wrong Gmail account");
  stage = "search";
  const page = decodeGmailSearch(
    await call("gmail.search", {
      query: `-in:sent -in:drafts -in:spam -in:trash after:${Math.floor(Number(request.after)) - 1} before:${Math.ceil(Number(request.before)) + 1}`,
      max_results: 20,
      ...(request.cursor ? { next_page_token: request.cursor } : {}),
    }),
  );
  stage = "read";
  const messages = [];
  for (const id of page.message_ids) {
    const message = parseGmailMessage(
      await call("gmail.read", { message_id: id, format: "full" }),
      request.accountEmail,
    );
    if (
      Number(message.receivedAt) > Number(request.after) &&
      Number(message.receivedAt) <= Number(request.before)
    )
      messages.push(message);
  }
  const known = new Set(request.knownIds ?? []);
  const recovery = request.recovery ?? [];
  const recoveredIds = new Set(recovery.map((m) => m.id));
  const combined = [...recovery, ...messages.filter((m) => !recoveredIds.has(m.id))];
  const collected = [];
  stage = "context";
  for (const message of combined) {
    if (message.accountEmail !== request.accountEmail) throw new Error("Recovered source mismatch");
    const needed =
      recoveredIds.has(message.id) ||
      (!known.has(message.id) &&
        acceptsGmailMessage(
          {
            accountEmail: request.accountEmail,
            excludeSenders: request.excludeSenders ?? [],
            excludeText: request.excludeText ?? [],
          },
          message,
        ));
    collected.push(
      needed
        ? { ...message, context: await collectContext({ kind: "gmail", message }, call) }
        : message,
    );
  }
  console.log(JSON.stringify({ messages: collected, nextCursor: page.next_page_token || null }));
} catch {
  console.error(
    `Gmail collection failed (${stage}): check the account, permissions and connector response format.`,
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  client.close();
}
