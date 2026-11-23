// @effect-diagnostics nodeBuiltinImport:off - Standalone installer runs outside the service it replaces.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { run } from "./commands.ts";
import type { RuntimeConfig } from "./config.ts";
import { currentRelease, withLock, writeJson } from "./state.ts";

const repository = "https://github.com/ValentinLepiller/Travail.git";
const ref = "refs/heads/main";
const sha = /^[a-f0-9]{40}$/;
const unit = "travail-install-update";
const statePath = (config: RuntimeConfig) =>
  NodePath.join(config.operations, "travail-update.json");

async function readOptional(file: string) {
  try {
    return await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function latestRevision(config: RuntimeConfig) {
  const output = await run(
    { program: "git", args: ["ls-remote", "--exit-code", repository, ref] },
    config.source,
    10_000,
  );
  const [revision, resolvedRef] = output.split("\t");
  if (!revision || !sha.test(revision) || resolvedRef !== ref) {
    throw new Error("Cannot resolve Travail main");
  }
  return revision;
}

async function installedRevision(release: string) {
  return (await readOptional(NodePath.join(release, ".t3/travail-revision")))?.trim();
}

export async function travailStatus(config: RuntimeConfig) {
  const [release, latest, activeState, state] = await Promise.all([
    currentRelease(config.operations),
    latestRevision(config),
    run(
      {
        program: "systemctl",
        args: ["--user", "show", "--property=ActiveState", "--value", unit + ".service"],
      },
      config.source,
      5_000,
    ),
    readOptional(statePath(config)),
  ]);
  const installed = await installedRevision(release);
  const installing = ["active", "activating", "deactivating", "reloading"].includes(activeState);
  const previous = state ? (JSON.parse(state) as { revision: string; phase: string }) : undefined;
  return {
    installed: installed ?? null,
    available: latest === installed ? null : latest,
    installing,
    failed:
      !installing &&
      latest !== installed &&
      previous?.revision === latest &&
      previous.phase !== "installed",
  };
}

export async function queueTravailUpdate(
  config: RuntimeConfig,
  controller: string,
  revision: string,
) {
  if (!sha.test(revision) || (await latestRevision(config)) !== revision) {
    throw new Error("Travail main changed. Check again before installing.");
  }
  await run(
    {
      program: "systemd-run",
      args: [
        "--user",
        "--quiet",
        "--collect",
        "--unit=" + unit,
        "--property=Type=exec",
        "--property=RuntimeMaxSec=90min",
        "--setenv=HARNESS_OPERATIONS=" + config.operations,
        "--setenv=PATH=" + config.path,
        process.execPath,
        controller,
        "travail-install",
        revision,
      ],
    },
    config.source,
    5_000,
  );
}

export async function installTravail(
  config: RuntimeConfig,
  requestedRevision: string | undefined,
  activate: (candidate: string, previous: string) => Promise<void>,
) {
  const revision = requestedRevision ?? (await latestRevision(config));
  if (!sha.test(revision)) throw new Error("Invalid Travail revision");
  try {
    const update = await withLock(config.operations, async () => {
      const previous = await currentRelease(config.operations);
      const installed = await installedRevision(previous);
      if (revision === installed) return null;
      await writeJson(statePath(config), { revision, phase: "installing" });
      const candidate = NodePath.join(
        config.operations,
        "releases",
        "travail-" + NodeCrypto.randomUUID(),
      );
      const exec = (program: string, args: string[]) =>
        run({ program, args }, candidate, config.commandTimeoutMs, {
          ...process.env,
          PATH: config.path,
          GIT_TERMINAL_PROMPT: "0",
        }).catch((cause: unknown) => {
          throw new Error(
            `Travail preparation failed: ${NodePath.basename(program)} ${args.slice(0, 2).join(" ")}`,
            { cause },
          );
        });
      await NodeFSP.mkdir(candidate, { recursive: true, mode: 0o700 });
      await exec("git", ["init", "--quiet"]);
      await exec("git", ["fetch", "--no-tags", repository, ref]);
      if ((await exec("git", ["rev-parse", "FETCH_HEAD"])) !== revision) {
        throw new Error("Travail main changed. Check again before installing.");
      }
      if (installed) await exec("git", ["merge-base", "--is-ancestor", installed, revision]);
      await exec("git", ["checkout", "--detach", revision]);
      const provider = NodePath.join(previous, ".harness-provider");
      if (
        await NodeFSP.stat(provider).then(
          () => true,
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          },
        )
      ) {
        await NodeFSP.cp(provider, NodePath.join(candidate, ".harness-provider"), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
      const vp = NodePath.join(candidate, "node_modules/.bin/vp");
      await exec("corepack", ["pnpm", "install", "--frozen-lockfile"]);
      await exec(vp, ["run", "--filter", "@t3tools/desktop", "build"]);
      await exec(vp, ["run", "--filter", "@t3tools/desktop", "ensure:electron"]);
      await NodeFSP.access(NodePath.join(candidate, "apps/desktop/dist-electron/main.cjs"));
      await NodeFSP.mkdir(NodePath.join(candidate, ".t3"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(candidate, ".t3/travail-revision"), revision + "\n");
      return { candidate, previous };
    });
    if (update) await activate(update.candidate, update.previous);
    await writeJson(statePath(config), { revision, phase: "installed" });
  } catch (error) {
    await writeJson(statePath(config), { revision, phase: "failed" });
    throw error;
  }
}
