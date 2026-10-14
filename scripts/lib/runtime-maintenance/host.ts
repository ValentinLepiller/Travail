// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Host process boundary using MT's prepared/committed IPC gate.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import type { RuntimeConfig } from "./config.ts";
import { currentRelease, writeJson } from "./state.ts";

export async function host(config: RuntimeConfig) {
  const root = await currentRelease(config.operations);
  const bootstrap: { prepareHarnessHome(home: string): Promise<void> } = await import(
    NodePath.join(root, "scripts", "lib", "harness-home.ts")
  );
  await bootstrap.prepareHarnessHome(config.home);
  const seed: { seedPrivateCodexHome(home: string): Promise<string> } = await import(
    NodePath.join(root, "scripts/lib/codex-home.ts")
  );
  const codexHome = await seed.seedPrivateCodexHome(NodePath.join(config.home, "codex"));
  const packageJson = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "apps", "server", "package.json"), "utf8"),
  ) as { version: string };
  const protocol: {
    SERVICE_LAUNCHER_PROTOCOL: number;
    SERVICE_LAUNCHER_CONTEXT_ENV: string;
    decodeServiceLauncherChildMessage(
      raw: unknown,
    ): { type: "prepared"; updateId: string } | { type: "request-update" } | undefined;
  } = await import(NodePath.join(root, "apps", "server", "src", "cloud", "serviceProtocol.ts"));
  const pending = await NodeFSP.readFile(
    NodePath.join(config.operations, "promotion.json"),
    "utf8",
  ).then(
    (raw) => JSON.parse(raw) as { phase: string; id: string; candidate: string; previous: string },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return null;
    },
  );
  const trial =
    pending !== null &&
    [
      "stopping",
      "backed-up",
      "switching",
      "switched",
      "activating",
      "restoring",
      "restored",
      "rollback-activating",
    ].includes(pending.phase) &&
    [pending.candidate, pending.previous].includes(root)
      ? pending
      : null;
  const previous =
    pending?.candidate === root
      ? (JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(pending.previous, "apps", "server", "package.json"),
            "utf8",
          ),
        ) as { version: string })
      : packageJson;
  const context = {
    protocol: protocol.SERVICE_LAUNCHER_PROTOCOL,
    childVersion: packageJson.version,
    ...(pending && (trial || (pending.candidate === root && pending.phase === "committed"))
      ? {
          update: {
            id: pending.id,
            fromVersion: previous.version,
            targetVersion: packageJson.version,
            dbPath: NodePath.join(config.home, "userdata", "statev2.sqlite"),
            status: trial ? "pending" : "committed",
          },
        }
      : {}),
  };
  await NodeFSP.rm(NodePath.join(config.operations, "trial-prepared.json"), { force: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(root, "apps", "server", "dist", "bin.mjs"),
      "serve",
      "--base-dir",
      config.home,
      "--host",
      "127.0.0.1",
      "--port",
      String(config.port),
      "--no-browser",
      ...(process.env.HARNESS_TAILSCALE_SERVE === "1" ? ["--tailscale-serve"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: config.path,
        TZ: config.timezone,
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
        MT_CONTEXT_CODEX_HOME: NodePath.join(process.env.HOME ?? "", ".codex"),
        T3CODE_HOME: config.home,
        T3CODE_NO_BROWSER: "1",
        [protocol.SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  const watchAbort = new AbortController();
  const watcher = NodeFSP.watch(config.operations, { signal: watchAbort.signal });
  let prepared = false;
  let activated = false;
  async function replayActivation() {
    if (!trial || !prepared || activated) return;
    const decision = JSON.parse(
      await NodeFSP.readFile(NodePath.join(config.operations, "promotion.json"), "utf8"),
    ) as { id: string; phase: string };
    if (
      !activated &&
      decision.id === trial.id &&
      ["activating", "rollback-activating"].includes(decision.phase)
    ) {
      activated = true;
      child.send({ type: "committed", updateId: trial.id });
      watchAbort.abort();
    }
  }
  if (trial) {
    void (async () => {
      for await (const event of watcher) {
        if (event.filename === "trial-commit.json" || event.filename === "promotion.json")
          await replayActivation();
      }
    })().catch((error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) child.kill("SIGTERM");
    });
  }
  child.on("message", (raw: unknown) => {
    const message = protocol.decodeServiceLauncherChildMessage(raw);
    if (message?.type === "prepared" && trial && message.updateId === trial.id) {
      prepared = true;
      void writeJson(NodePath.join(config.operations, "trial-prepared.json"), {
        id: trial.id,
        hostPid: process.pid,
        serverPid: child.pid,
      })
        .then(replayActivation)
        .catch(() => child.kill("SIGTERM"));
    } else if (message?.type === "request-update") {
      child.send({
        type: "update-rejected",
        reason: "Harness updates require isolated validation",
      });
    }
  });
  child.on("error", () => {
    watchAbort.abort();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    watchAbort.abort();
    process.exitCode = code ?? 1;
  });
}
