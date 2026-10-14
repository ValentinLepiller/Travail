// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - Scheduled operations boundary, never updates global installations.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { seedPrivateCodexHome } from "../codex-home.ts";
import { run } from "./commands.ts";
import type { RuntimeConfig } from "./config.ts";
import { fingerprint, requiredUsages, type Validation, type Usage } from "./promotion.ts";
import { currentRelease, writeJson } from "./state.ts";

export async function detect(config: RuntimeConfig) {
  const readHead = async (source: { url: string; ref: string }) => {
    const result = await run(
      { program: "git", args: ["ls-remote", source.url, source.ref] },
      config.source,
    );
    const sha = result.split(/\s/)[0];
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Cannot resolve upstream commit");
    return sha;
  };
  const version = async () => {
    const response = await fetch("https://registry.npmjs.org/@openai%2Fcodex/latest", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Cannot check Codex release");
    const value = (await response.json()) as { version?: unknown };
    if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version))
      throw new Error("Invalid Codex version");
    return value.version;
  };
  const [mt, t3, codex] = await Promise.all([readHead(config.mt), readHead(config.t3), version()]);
  return { mt, t3, codex };
}

export async function hasUpdate(
  config: RuntimeConfig,
  updates: Awaited<ReturnType<typeof detect>>,
) {
  const current = await currentRelease(config.operations);
  const installed = await NodeFSP.readFile(
    NodePath.join(current, ".t3", "upstreams.json"),
    "utf8",
  ).then(
    (raw) => JSON.parse(raw) as { mt: string; codex: string },
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return null;
    },
  );
  return installed === null || installed.mt !== updates.mt || installed.codex !== updates.codex;
}

export async function validate(config: RuntimeConfig, candidate: string) {
  const usages = Object.fromEntries(requiredUsages.map((usage) => [usage, false])) as Record<
    Usage,
    boolean
  >;
  const codexHome = await seedPrivateCodexHome(
    NodePath.join(candidate, ".t3/validation/codex"),
    NodePath.join(config.home, "codex"),
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${NodePath.join(candidate, ".harness-provider", "node_modules", ".bin")}${NodePath.delimiter}${config.path
      .split(NodePath.delimiter)
      .filter((part) => part !== NodePath.join(config.operations, "provider-bin"))
      .join(NodePath.delimiter)}`,
    TZ: config.timezone,
    T3CODE_HOME: NodePath.join(candidate, ".t3", "validation"),
    HARNESS_HOME: NodePath.join(candidate, ".t3", "validation"),
    HARNESS_TAILSCALE_SERVE: "0",
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    HARNESS_RECOVERY_CONTROLLER: NodePath.join(
      config.operations,
      "controller",
      "harness-runtime.ts",
    ),
  };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  const before = await fingerprint(candidate);
  for (const usage of requiredUsages) {
    const checks = config.checks[usage];
    if (checks === undefined || checks.length === 0)
      throw new Error(`No validation configured for ${usage}`);
    for (const check of checks) {
      try {
        await run(check, candidate, config.commandTimeoutMs, environment);
      } catch (error) {
        throw new Error(
          `Validation ${usage} failed: ${error instanceof Error ? error.message : "command failure"}`,
          { cause: error },
        );
      }
    }
    usages[usage] = true;
  }
  if (before !== (await fingerprint(candidate)))
    throw new Error("Checks modified the candidate artifact");
  const validation: Validation = { fingerprint: before, usages };
  await writeJson(NodePath.join(candidate, ".t3", "validation.json"), validation);
  return validation;
}

/** Preparation stays on a separate git branch; T3 is observed, MT alone is merged. */
export async function prepareCandidate(
  config: RuntimeConfig,
  updates: Awaited<ReturnType<typeof detect>>,
) {
  const source = await currentRelease(config.operations);
  if ((await run({ program: "git", args: ["status", "--porcelain"] }, source)) !== "")
    throw new Error("Source has uncommitted changes");
  const id = `maintenance-${NodeCrypto.randomUUID()}`;
  const candidate = NodePath.join(config.operations, "releases", id);
  await NodeFSP.mkdir(NodePath.dirname(candidate), { recursive: true, mode: 0o700 });
  await run(
    { program: "git", args: ["clone", "--no-hardlinks", "--no-local", source, candidate] },
    source,
  );
  await run(
    { program: "git", args: ["remote", "set-url", "--push", "origin", "DISABLED"] },
    candidate,
  );
  await NodeFSP.appendFile(
    NodePath.join(candidate, ".git", "info", "exclude"),
    "\n.harness-provider/\n",
  );
  await run({ program: "git", args: ["checkout", "-b", id] }, candidate);
  await run({ program: "git", args: ["fetch", config.mt.url, config.mt.ref] }, candidate);
  const actual = await run({ program: "git", args: ["rev-parse", "FETCH_HEAD"] }, candidate);
  if (actual !== updates.mt) throw new Error("Upstream changed during preparation; retry tomorrow");
  let needsAdaptation = false;
  try {
    await run({ program: "git", args: ["merge", "--no-edit", "FETCH_HEAD"] }, candidate);
  } catch {
    needsAdaptation = true;
  }
  if (needsAdaptation && !config.adaptWithAgent)
    throw new Error("MT merge needs an adaptation agent");
  if (config.adaptWithAgent) {
    const maintenanceHome = await seedPrivateCodexHome(
      NodePath.join(candidate, ".t3/adaptation-codex"),
      NodePath.join(config.home, "codex"),
    );
    const agentEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: config.path,
      CODEX_HOME: maintenanceHome,
      CODEX_SQLITE_HOME: maintenanceHome,
    };
    delete agentEnvironment.OPENAI_API_KEY;
    delete agentEnvironment.CODEX_API_KEY;
    const prompt =
      "Adapt this isolated harness branch to the merged MT upstream. Resolve conflicts and preserve SPECS.md and native subscription authentication. Work only in this candidate directory. Do not change daily installations, publish, push, expose listeners, spend API credits, or send external messages. Use focused tests and simplify. Commit only candidate changes when complete; stop and report if a human decision is needed. One bounded attempt is allowed.";
    await run(
      {
        program: NodePath.join(config.operations, "provider-bin", "codex"),
        args: ["exec", "--sandbox", "workspace-write", "-c", 'approval_policy="never"', prompt],
      },
      candidate,
      config.agentTimeoutMs,
      agentEnvironment,
    );
  }
  if ((await run({ program: "git", args: ["status", "--porcelain"] }, candidate)) !== "")
    throw new Error("Candidate adaptation is incomplete");
  await run(
    { program: "corepack", args: ["pnpm", "install", "--frozen-lockfile"] },
    candidate,
    config.commandTimeoutMs,
  );
  // npm prefix installs Codex only inside this candidate, never the daily executable.
  await run(
    {
      program: "npm",
      args: [
        "install",
        "--prefix",
        NodePath.join(candidate, ".harness-provider"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@openai/codex@${updates.codex}`,
      ],
    },
    candidate,
    config.commandTimeoutMs,
  );
  await run(
    {
      program: process.execPath,
      args: [
        NodePath.join(
          candidate,
          ".harness-provider",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        ),
        "--version",
      ],
    },
    candidate,
  );
  await run(
    {
      program: NodePath.join(candidate, "node_modules", ".bin", "vp"),
      args: ["run", "--filter", "t3", "build"],
    },
    candidate,
    config.commandTimeoutMs,
  );
  await writeJson(NodePath.join(candidate, ".t3", "upstreams.json"), updates);
  return candidate;
}
