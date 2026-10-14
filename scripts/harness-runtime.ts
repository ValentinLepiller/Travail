#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off - Independent operations CLI; never relies on the app being startable.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { isolateHarnessCodex } from "./lib/codex-home.ts";
import * as NodeOS from "node:os";
import { defaultChecks } from "./lib/runtime-maintenance/checks.ts";
import { run } from "./lib/runtime-maintenance/commands.ts";
import { decodeConfig, type RuntimeConfig } from "./lib/runtime-maintenance/config.ts";
import { detect, hasUpdate, prepareCandidate, validate } from "./lib/runtime-maintenance/daily.ts";
import {
  promote,
  recover,
  rollback,
  type RuntimeControl,
  type Validation,
} from "./lib/runtime-maintenance/promotion.ts";
import { admissionLease } from "./lib/runtime-maintenance/quiescence.ts";
import { awaitReady } from "./lib/runtime-maintenance/ready.ts";
import { host } from "./lib/runtime-maintenance/host.ts";
import * as NodeTimersPromises from "node:timers/promises";
import {
  assertIdle,
  currentRelease,
  switchRelease,
  withLock,
  writeJson,
} from "./lib/runtime-maintenance/state.ts";

const source = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const operations = NodePath.resolve(
  process.env.HARNESS_OPERATIONS ?? NodePath.join(source, ".t3", "harness-operations"),
);
const configPath = NodePath.join(operations, "config.json");
const mode = process.argv[2];
const candidate = process.argv[3];

async function readConfig() {
  return decodeConfig(JSON.parse(await NodeFSP.readFile(configPath, "utf8")));
}

async function health(config: RuntimeConfig) {
  const origin = `http://127.0.0.1:${config.port}`;
  const descriptor = await fetch(`${origin}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!descriptor.ok) throw new Error("MT descriptor unavailable");
  const info = (await descriptor.json()) as {
    environmentId?: unknown;
    orchestrationProtocolVersion?: unknown;
  };
  if (info.environmentId !== config.environmentId || info.orchestrationProtocolVersion !== 2)
    throw new Error("Unexpected MT environment");
  const auth = await fetch(`${origin}/api/orchestration/shell`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (auth.status !== 401) throw new Error("MT auth boundary unavailable");
  for (const check of config.postPromotionChecks)
    await run(check, await currentRelease(config.operations), config.commandTimeoutMs, {
      ...process.env,
      PATH: config.path,
      HARNESS_HOME: config.home,
      TZ: config.timezone,
    });
}

function control(config: RuntimeConfig): RuntimeControl {
  const systemctl = (command: string) =>
    run(
      { program: "systemctl", args: ["--user", command, "mt-harness.service"] },
      config.source,
    ).then(() => undefined);
  return {
    quiesce: (id) => admissionLease(config, "quiesce", id),
    releaseQuiescence: (id) => admissionLease(config, "release", id),
    stop: () => systemctl("stop"),
    start: async () => {
      await systemctl("start");
      const hostPid = Number(
        await run(
          {
            program: "systemctl",
            args: ["--user", "show", "mt-harness.service", "--property=MainPID", "--value"],
          },
          config.source,
        ),
      );
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          const journal = JSON.parse(
            await NodeFSP.readFile(NodePath.join(config.operations, "promotion.json"), "utf8"),
          ) as { phase: string; id: string };
          if (
            [
              "stopping",
              "backed-up",
              "switching",
              "switched",
              "activating",
              "restoring",
              "restored",
              "rollback-activating",
            ].includes(journal.phase)
          ) {
            const prepared = JSON.parse(
              await NodeFSP.readFile(
                NodePath.join(config.operations, "trial-prepared.json"),
                "utf8",
              ),
            ) as { id: string; hostPid: number };
            if (prepared.id === journal.id && prepared.hostPid === hostPid && hostPid > 0) return;
          } else {
            await health(config);
            return;
          }
        } catch {}
        await NodeTimersPromises.setTimeout(200);
      }
      throw new Error("Host did not become ready within 30 seconds");
    },
    check: async () => {
      const hostPid = Number(
        await run(
          {
            program: "systemctl",
            args: ["--user", "show", "mt-harness.service", "--property=MainPID", "--value"],
          },
          config.source,
        ),
      );
      const journal = JSON.parse(
        await NodeFSP.readFile(NodePath.join(config.operations, "promotion.json"), "utf8"),
      ) as { phase: string; id: string };
      if (
        [
          "stopping",
          "backed-up",
          "switching",
          "switched",
          "activating",
          "restoring",
          "restored",
          "rollback-activating",
        ].includes(journal.phase)
      ) {
        const prepared = JSON.parse(
          await NodeFSP.readFile(NodePath.join(config.operations, "trial-prepared.json"), "utf8"),
        ) as { id: string; hostPid: number };
        if (prepared.id !== journal.id || prepared.hostPid !== hostPid || hostPid === 0)
          throw new Error("Candidate was not prepared");
      } else await health(config);
    },
    ready: async (id) => {
      await awaitReady(config, id);
      await health(config);
    },
    activate: async () => {
      const journal = JSON.parse(
        await NodeFSP.readFile(NodePath.join(config.operations, "promotion.json"), "utf8"),
      ) as { id: string };
      await writeJson(NodePath.join(config.operations, "trial-commit.json"), { id: journal.id });
    },
  };
}

async function init() {
  await NodeFSP.mkdir(operations, { recursive: true, mode: 0o700 });
  const home = NodePath.join(source, ".t3", "harness");
  const node = await NodeFSP.realpath(process.execPath);
  const nativeCodex = await NodeFSP.realpath(NodePath.join(NodePath.dirname(node), "codex"));
  const saved = await NodeFSP.readFile(configPath, "utf8").then(
    (raw) => decodeConfig(JSON.parse(raw)),
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return null;
    },
  );
  const info =
    saved ??
    ((await (
      await fetch("http://127.0.0.1:3773/.well-known/t3/environment", {
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as { environmentId: string });
  const config: RuntimeConfig = {
    source,
    home,
    operations,
    port: 3773,
    timezone: "Europe/Paris",
    environmentId: info.environmentId,
    nativeCodex,
    path: `${operations}/provider-bin:${NodePath.dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    prepareUpdates: false,
    adaptWithAgent: false,
    promoteValidated: false,
    agentTimeoutMs: 1_200_000,
    commandTimeoutMs: 1_200_000,
    mt: { url: "https://github.com/munimtechnologies/mtcode.git", ref: "refs/heads/main" },
    t3: { url: "https://github.com/pingdotgg/t3code.git", ref: "refs/heads/main" },
    checks: defaultChecks(node),
    postPromotionChecks: [
      {
        program: node,
        args: [
          NodePath.join(source, "scripts/harness-remote.ts"),
          "health",
          NodePath.join(source, ".t3/harness-remote/config.json"),
          configPath,
        ],
      },
    ],
  };
  // Refreshing the independent recovery code is explicit; config and release selection are preserved.
  const controller = NodePath.join(operations, "controller");
  await NodeFSP.mkdir(NodePath.join(controller, "lib"), { recursive: true });
  await NodeFSP.copyFile(
    NodeURL.fileURLToPath(import.meta.url),
    NodePath.join(controller, "harness-runtime.ts"),
  );
  await NodeFSP.copyFile(
    NodePath.join(source, "scripts/lib/codex-home.ts"),
    NodePath.join(controller, "lib/codex-home.ts"),
  );
  await NodeFSP.copyFile(
    NodePath.join(source, "scripts", "lib", "cli-external-packages.ts"),
    NodePath.join(controller, "lib", "cli-external-packages.ts"),
  );
  await NodeFSP.cp(
    NodePath.join(source, "scripts", "lib", "runtime-maintenance"),
    NodePath.join(controller, "lib", "runtime-maintenance"),
    { recursive: true },
  );
  try {
    await NodeFSP.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  try {
    await currentRelease(operations);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await switchRelease(operations, source);
  }
  const existing = await readConfig();
  if (Object.keys(existing.checks).length === 0) {
    existing.checks = defaultChecks(node);
    await writeJson(configPath, existing);
  }
  const units = NodePath.join(process.env.HOME ?? "", ".config", "systemd", "user");
  await NodeFSP.mkdir(units, { recursive: true });
  const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
  const command = `${quote(node)} ${quote(NodePath.join(controller, "harness-runtime.ts"))}`;
  const environment = `Environment=HARNESS_OPERATIONS=${quote(operations)}\nEnvironment=PATH=${quote(config.path)}\n`;
  await NodeFSP.writeFile(
    NodePath.join(units, "mt-harness.service"),
    `[Unit]\nDescription=Valentin MT harness host\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=simple\n${environment}ExecStart=${command} host\nKillMode=mixed\nOOMPolicy=continue\nRestart=always\nRestartSec=5\nTimeoutStopSec=90\nUMask=0077\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(units, "mt-harness-maintenance.service"),
    `[Unit]\nDescription=MT harness daily update inspection\n\n[Service]\nType=oneshot\n${environment}ExecStart=${command} daily\nTimeoutStartSec=90min\nUMask=0077\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(units, "mt-harness-maintenance.timer"),
    `[Unit]\nDescription=MT harness daily inspection at 04:00 Europe/Paris\n\n[Timer]\nOnCalendar=*-*-* 04:00:00 Europe/Paris\nPersistent=true\nRandomizedDelaySec=5min\nUnit=mt-harness-maintenance.service\n\n[Install]\nWantedBy=timers.target\n`,
  );
  await NodeFSP.mkdir(NodePath.join(operations, "provider-bin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(operations, "provider-bin", "codex"),
    `#!/bin/sh\nexec ${quote(node)} ${quote(NodePath.join(controller, "harness-runtime.ts"))} codex "$@"\n`,
    { mode: 0o700 },
  );
  await run({ program: "systemctl", args: ["--user", "daemon-reload"] }, source);
  console.log("Prepared/refreshed units and recovery controller; no service restart performed");
}

async function main() {
  if (mode === "init") return init();
  const config = await readConfig();
  if (mode === "isolate-codex") {
    const home = await isolateHarnessCodex(
      config.home,
      candidate ?? NodePath.join(NodeOS.homedir(), ".codex"),
    );
    console.log(
      JSON.stringify({
        privateCodexHome: home,
        historicalDatabasesCopied: false,
        originalHomeWritten: false,
      }),
    );
    return;
  }
  if (mode === "pin-native")
    return withLock(operations, async () => {
      const version = (
        await run(
          { program: process.execPath, args: [config.nativeCodex, "--version"] },
          config.source,
        )
      ).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
      if (!version) throw new Error("Cannot pin the existing Codex version");
      const prefix = NodePath.join(operations, "provider-baseline");
      await run(
        {
          program: "npm",
          args: [
            "install",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            `@openai/codex@${version}`,
          ],
        },
        config.source,
        config.commandTimeoutMs,
      );
      const binary = NodePath.join(prefix, "node_modules/@openai/codex/bin/codex.js");
      const installed = await run(
        { program: process.execPath, args: [binary, "--version"] },
        config.source,
      );
      if (!installed.includes(` ${version}`))
        throw new Error("Dedicated Codex version differs from baseline");
      config.nativeCodex = binary;
      await writeJson(configPath, config);
      console.log(JSON.stringify({ dedicatedCodex: version, globalInstallationChanged: false }));
    });
  if (mode === "status") {
    const state = await NodeFSP.readFile(NodePath.join(operations, "daily.json"), "utf8").then(
      (raw) => JSON.parse(raw) as { phase: string; candidate?: string; error?: string },
      () => ({ phase: "never-run" }),
    );
    const promotion = await NodeFSP.readFile(
      NodePath.join(operations, "promotion.json"),
      "utf8",
    ).then(
      (raw) => {
        const value = JSON.parse(raw) as { phase: string };
        return value.phase;
      },
      () => "none",
    );
    console.log(
      JSON.stringify(
        {
          promotion,
          current: await currentRelease(operations),
          maintenance: state,
          autoPrepare: config.prepareUpdates,
          autoAgent: config.adaptWithAgent,
          autoPromotion: config.promoteValidated,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "health") return health(config);
  if (mode === "idle") return assertIdle(config.home);
  if (mode === "host") return host(config);
  if (mode === "codex") {
    const NodeChildProcess = await import("node:child_process");
    const root = await currentRelease(operations);
    const pinned = NodePath.join(
      root,
      ".harness-provider",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    const binary = await NodeFSP.access(pinned).then(
      () => pinned,
      () => config.nativeCodex,
    );
    const child = NodeChildProcess.spawn(process.execPath, [binary, ...process.argv.slice(3)], {
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (mode === "recover" || mode === "rollback")
    return withLock(operations, () =>
      mode === "recover"
        ? recover(config, control(config))
        : rollback(config, control(config), candidate === "--restore-snapshot"),
    );
  if (mode === "validate" && candidate) return validate(config, NodePath.resolve(candidate));
  if (mode === "promote" && candidate) {
    const release = NodePath.resolve(candidate);
    const validation = JSON.parse(
      await NodeFSP.readFile(NodePath.join(release, ".t3", "validation.json"), "utf8"),
    ) as Validation;
    return promote(config, release, validation, control(config));
  }
  if (mode === "daily" || mode === "retry") {
    let release: string | undefined;
    await withLock(operations, async () => {
      if (mode === "retry")
        await NodeFSP.rm(NodePath.join(operations, "blocked.json"), { force: true });
      const state = {
        phase: "detecting",
        startedAt: new Date().toISOString(),
        candidate: release,
        error: "",
      };
      const task = NodePath.join(operations, "daily.json");
      await writeJson(task, state);
      try {
        const updates = await detect(config);
        await writeJson(NodePath.join(operations, "updates.json"), updates);
        if (config.prepareUpdates && (await hasUpdate(config, updates))) {
          const blocked = await NodeFSP.stat(NodePath.join(operations, "blocked.json")).then(
            () => true,
            (error: unknown) => {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                throw error;
              return false;
            },
          );
          if (blocked)
            throw new Error("Maintenance needs explicit retry after its previous failure");
          state.phase = "preparing";
          await writeJson(task, state);
          release = await prepareCandidate(config, updates);
          state.candidate = release;
          state.phase = "validating";
          await writeJson(task, state);
          await validate(config, release);
        }
        state.phase = release ? "validated" : "detected";
      } catch (error) {
        if (["preparing", "validating"].includes(state.phase))
          await writeJson(NodePath.join(operations, "blocked.json"), {
            phase: state.phase,
            candidate: state.candidate,
          });
        state.phase = "failed";
        state.error = error instanceof Error ? error.message : "Maintenance failed";
        throw error;
      } finally {
        await writeJson(task, state);
        await writeJson(
          NodePath.join(operations, "history", `${state.startedAt.replaceAll(":", "-")}.json`),
          state,
        );
      }
    });
    if (release && config.promoteValidated) {
      const validation = JSON.parse(
        await NodeFSP.readFile(NodePath.join(release, ".t3", "validation.json"), "utf8"),
      ) as Validation;
      await promote(config, release, validation, control(config));
    }
    return;
  }
  throw new Error(
    "Usage: harness-runtime.ts init|host|health|status|isolate-codex|pin-native|idle|daily|retry|validate PATH|promote PATH|recover|rollback",
  );
}
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Runtime operation failed");
  process.exitCode = 1;
  if (["daily", "retry", "promote", "recover", "rollback"].includes(mode ?? ""))
    void run(
      {
        program: "notify-send",
        args: [
          "MT Harness",
          "Maintenance/runtime failed. Run harness-runtime.ts status; no automatic promotion succeeded.",
        ],
      },
      source,
      5_000,
    ).catch(() => undefined);
});
