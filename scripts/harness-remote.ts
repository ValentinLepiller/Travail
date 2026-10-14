#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - Remote operations CLI independent of the MT app runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { decodeRemoteConfig } from "./lib/harness-remote/config.ts";
import { assertMtAuth } from "./lib/harness-remote/gateway.ts";
import { startRemote, remoteUnit } from "./lib/harness-remote/tunnel.ts";
import { healthRemote } from "./lib/harness-remote/health.ts";
import { decodeConfig as decodeRuntimeConfig } from "./lib/runtime-maintenance/config.ts";

try {
  const [command, file, runtimeFile] = process.argv.slice(2);
  if (!file || !["check", "prepare", "run", "health"].includes(command ?? ""))
    throw new Error(
      "Usage: node scripts/harness-remote.ts check|prepare|run|health /absolute/config.json [runtime-config.json]",
    );
  const configFile = await NodeFSP.realpath(file);
  const config = decodeRemoteConfig(JSON.parse(await NodeFSP.readFile(configFile, "utf8")));
  if (command === "prepare") {
    const units = NodePath.join(NodeOS.homedir(), ".config", "systemd", "user");
    await NodeFSP.mkdir(units, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(units, "mt-harness-remote.service"),
      remoteUnit(
        await NodeFSP.realpath(process.execPath),
        NodeURL.fileURLToPath(import.meta.url),
        configFile,
      ),
      { mode: 0o600 },
    );
    console.log(
      "Remote unit prepared; not enabled or started. After validation: systemctl --user daemon-reload, then enable mt-harness-remote.service and restart it only with parent coordination.",
    );
  } else if (command === "check") {
    await assertMtAuth(config.origin, config.environmentId);
    console.log(
      JSON.stringify({
        origin: config.origin,
        identityVerified: true,
        anonymousHttp: 401,
        anonymousWebSocket: 401,
        mode: config.mode,
        stableAddress: config.mode === "named" ? `https://${config.hostname}` : null,
      }),
    );
  } else if (command === "health") {
    const runtime = runtimeFile
      ? decodeRuntimeConfig(JSON.parse(await NodeFSP.readFile(runtimeFile, "utf8")))
      : undefined;
    console.log(JSON.stringify(await healthRemote(config, runtime)));
  } else {
    const abort = new AbortController();
    const interrupted = () => abort.abort();
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    let tunnel: Awaited<ReturnType<typeof startRemote>> | undefined;
    try {
      tunnel = await startRemote(config, abort.signal);
      const status = {
        origin: tunnel.origin,
        temporary: config.mode === "quick",
        auth: "MT pairing/session required",
        sharedOrigin: new URL(config.origin).port === "3773",
      };
      const statusFile = NodePath.join(config.directory, "status.json");
      await NodeFSP.writeFile(statusFile, JSON.stringify(status, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(status));
      const code = await tunnel.completion;
      await NodeFSP.writeFile(statusFile, JSON.stringify({ ...status, stopped: true }), {
        mode: 0o600,
      });
      process.exitCode = abort.signal.aborted ? 0 : code || 1;
    } finally {
      await tunnel?.stop();
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Remote operation failed");
  process.exitCode = 1;
}
