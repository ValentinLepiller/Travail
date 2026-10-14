// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Agent-facing command line adapter.
import * as NodeUtil from "node:util";
import { openNativeApps, installedApps, connectorThread } from "./native.ts";
import { callConnector } from "./adapter.ts";

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { "allow-write": { type: "boolean", default: false } },
});
const client = await openNativeApps();
try {
  if (positionals[0] === "status") {
    const apps = await installedApps(client.rpc);
    console.log(
      JSON.stringify(
        {
          transport: "native Codex app-server; Desktop environment removed except CODEX_HOME",
          apps,
          teams: {
            callable: apps.some(
              (app) =>
                /^(teams|microsoft teams)$/i.test(String(app.runtimeName)) && app.callable === true,
            ),
            connection:
              "Teams connector is available in the catalog; when absent from installed apps, connect the Microsoft account with the tenant's consent in the harness",
          },
          whatsapp: {
            callable: apps.some(
              (app) => /^whatsapp$/i.test(String(app.runtimeName)) && app.callable === true,
            ),
            connection:
              "No personal WhatsApp API integration is configured; a Business API is a separate account and authorization",
          },
        },
        null,
        2,
      ),
    );
  } else if (positionals[0] === "call") {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 64_000) throw new Error("Request exceeds 64 KB");
    }
    const threadId = await connectorThread(client.rpc);
    console.log(
      JSON.stringify(
        await callConnector(client.rpc, threadId, JSON.parse(text), values["allow-write"]),
      ),
    );
  } else {
    throw new Error(
      "Usage: node scripts/connectors/cli.ts status | call [--allow-write]; call reads a JSON request from stdin",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Connector failed");
  process.exitCode = 1;
} finally {
  client.close();
}
