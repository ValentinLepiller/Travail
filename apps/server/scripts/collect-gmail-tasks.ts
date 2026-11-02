// @effect-diagnostics globalConsole:off -- Standalone connector process; stdout is its JSON protocol.
import * as Schema from "effect/Schema";
import { openNativeApps, connectorThread } from "../../../scripts/connectors/native.ts";
import { callConnector, connectorData } from "../../../scripts/connectors/adapter.ts";
import { GmailCollectionInput } from "../src/workTasks/gmailTaskRules.ts";
import { decodeGmailSearch, parseGmailMessage } from "../src/workTasks/gmailSearchPage.ts";
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (input.length > 16_000) throw new Error("Collection input too large");
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
    operation: "gmail.profile" | "gmail.search" | "gmail.read",
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
  console.log(JSON.stringify({ messages, nextCursor: page.next_page_token || null }));
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
