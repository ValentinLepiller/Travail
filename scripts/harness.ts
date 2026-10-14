#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Process launcher boundary; delegates the Effect runtime to MT's existing dev runner and server.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { prepareHarnessHome } from "./lib/harness-home.ts";

const mode = process.argv[2] ?? "dev";
if (!["prepare", "dev", "start"].includes(mode) || process.argv.length > 3) {
  throw new Error("Usage: node scripts/harness.ts [prepare|dev|start]");
}
const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const home = NodePath.join(root, ".t3", "harness");
await prepareHarnessHome(home);
console.log(`[harness] Isolated state: ${home}`);
if (mode !== "prepare") {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    T3CODE_HOME: home,
    T3CODE_HOST: "127.0.0.1",
    T3CODE_NO_BROWSER: "1",
  };
  // Ambient launch overrides must not switch this environment to token-sharing or desktop control.
  delete environment.T3CODE_CODEX_LAUNCH_ARGS;
  delete environment.VITE_HTTP_URL;
  delete environment.VITE_WS_URL;
  const args =
    mode === "dev"
      ? ["scripts/dev-runner.ts", "dev", "--home-dir", home, "--host", "127.0.0.1"]
      : [
          "apps/server/dist/bin.mjs",
          "serve",
          "--base-dir",
          home,
          "--host",
          "127.0.0.1",
          "--no-browser",
        ];
  const child = NodeChildProcess.spawn(process.execPath, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}
