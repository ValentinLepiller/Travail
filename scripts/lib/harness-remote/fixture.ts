// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalTimers:off - Isolated live transport fixture, no personal state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { prepareHarnessHome } from "../harness-home.ts";
import { startRemote } from "./tunnel.ts";

const root = process.cwd();
const base = NodePath.join(root, ".t3", "harness-remote-fixtures");
await NodeFSP.mkdir(base, { recursive: true, mode: 0o700 });
const home = await NodeFSP.mkdtemp(NodePath.join(base, "proof-"));
await prepareHarnessHome(home);
const dist = NodePath.join(home, "release", "dist");
await NodeFSP.cp(NodePath.join(root, "apps", "server", "dist"), dist, { recursive: true });
await NodeFSP.symlink(
  NodePath.join(root, "apps", "server", "node_modules"),
  NodePath.join(home, "release", "node_modules"),
);
const env = { ...process.env, T3CODE_HOME: home, T3CODE_NO_BROWSER: "1" };
for (const key of [
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "T3CODE_CODEX_LAUNCH_ARGS",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
])
  delete env[key as keyof typeof env];
const backend = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(dist, "bin.mjs"),
    "serve",
    "--base-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    "3873",
    "--no-browser",
  ],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
const exit = new Promise<void>((resolve) => backend.once("close", () => resolve()));
let tunnel: Awaited<ReturnType<typeof startRemote>> | undefined;
let stopRequested = false;
const stopped = Promise.withResolvers<void>();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopRequested = true;
    stopped.resolve();
  });
try {
  const ready = Promise.withResolvers<string>();
  let checking = false;
  let pendingLog = false;
  let finished = false;
  const requestAbort = new AbortController();
  const timeout = setTimeout(
    () => ready.reject(new Error("MT fixture did not become ready")),
    30_000,
  );
  backend.once("error", () => ready.reject(new Error("Cannot start MT fixture")));
  backend.once("close", () => ready.reject(new Error("MT fixture exited before readiness")));
  const checkDescriptor = () => {
    if (finished) return;
    if (checking) {
      pendingLog = true;
      return;
    }
    checking = true;
    void fetch("http://127.0.0.1:3873/.well-known/t3/environment", {
      signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(5_000)]),
    })
      .then((response) => response.json())
      .then((value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "environmentId" in value &&
          typeof value.environmentId === "string"
        )
          ready.resolve(value.environmentId);
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
        if (pendingLog) {
          pendingLog = false;
          checkDescriptor();
        }
      });
  };
  backend.stdout.on("data", checkDescriptor);
  backend.stderr.on("data", checkDescriptor);
  let environmentId: string;
  try {
    environmentId = await Promise.race([
      ready.promise,
      stopped.promise.then(() => {
        throw new Error("Fixture stopped");
      }),
    ]);
  } finally {
    finished = true;
    clearTimeout(timeout);
    requestAbort.abort();
    backend.stdout.removeListener("data", checkDescriptor);
    backend.stdout.resume();
    backend.stderr.removeListener("data", checkDescriptor);
    backend.stderr.resume();
  }
  tunnel = await startRemote({
    origin: "http://127.0.0.1:3873",
    environmentId,
    proxyPort: 3874,
    mode: "quick",
    directory: NodePath.join(home, "remote"),
    sharedOriginApproved: false,
  });
  const status = {
    origin: tunnel.origin,
    temporary: true,
    home,
    dist,
    backendPid: backend.pid,
    environmentId,
    sharedPortPublished: false,
  };
  await NodeFSP.writeFile(
    NodePath.join(root, ".logs", "harness", "remote", "fixture.json"),
    JSON.stringify(status, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(status));
  await Promise.race([tunnel.completion, stopped.promise, exit]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Remote fixture failed");
  if (!stopRequested) process.exitCode = 1;
} finally {
  await tunnel?.stop();
  backend.kill("SIGTERM");
  const force = setTimeout(() => backend.kill("SIGKILL"), 5_000);
  await exit;
  clearTimeout(force);
}
