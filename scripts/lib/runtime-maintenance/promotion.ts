// @effect-diagnostics nodeBuiltinImport:off - Transaction/recovery filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import { runtimePackages } from "./dependencies.ts";
import {
  assertIdle,
  currentRelease,
  switchRelease,
  stateDigest,
  withLock,
  writeJson,
} from "./state.ts";

export const requiredUsages = [
  "agents",
  "delegation",
  "connectors",
  "voice",
  "remote",
  "desktops",
  "scheduling",
] as const;
export type Usage = (typeof requiredUsages)[number];
export interface Validation {
  readonly fingerprint: string;
  readonly usages: Record<Usage, boolean>;
}
export interface RuntimeControl {
  stop(): Promise<void>;
  start(): Promise<void>;
  check(): Promise<void>;
  activate(): Promise<void>;
  ready(updateId: string): Promise<void>;
  quiesce(operationId: string): Promise<void>;
  releaseQuiescence(operationId: string): Promise<void>;
}
export interface RuntimePaths {
  readonly operations: string;
  readonly home: string;
}
interface Journal {
  id: string;
  rollbackLease?: string;
  committedState?: string;
  preservedStates?: string[];
  phase:
    | "quiescing"
    | "stopping"
    | "backed-up"
    | "switching"
    | "switched"
    | "activating"
    | "restoring"
    | "restored"
    | "rollback-activating"
    | "committed"
    | "rolled-back";
  previous: string;
  candidate: string;
  backup: string;
}

/** Seal exactly the executable artifact (including bundled client), launcher and dependencies. */
export async function fingerprint(release: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  async function walk(relative: string, base = release) {
    const path = NodePath.join(base, relative);
    const stat = await NodeFSP.lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Release artifacts must not be symlinks");
    hash.update(relative + "\0" + (stat.mode & 0o777) + "\0");
    if (stat.isDirectory()) {
      for (const name of (await NodeFSP.readdir(path)).sort()) {
        if (name !== "node_modules") await walk(NodePath.join(relative, name), base);
      }
    } else {
      for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
    }
  }
  for (const entry of [
    "apps/server/dist",
    "apps/server/package.json",
    "scripts/harness.ts",
    "scripts/lib/harness-home.ts",
    "scripts/lib/codex-home.ts",
    "pnpm-lock.yaml",
    "apps/server/src/cloud/serviceProtocol.ts",
  ])
    await walk(entry);
  for (const pkg of await runtimePackages(release)) {
    hash.update(pkg.name + "\0");
    await walk(".", pkg.directory);
  }
  const provider = await NodeFSP.stat(NodePath.join(release, ".harness-provider")).catch(
    (error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return null;
    },
  );
  if (provider !== null) {
    const binary = NodePath.join(
      release,
      ".harness-provider/node_modules/@openai/codex/bin/codex.js",
    );
    const command = NodePath.join(release, ".harness-provider/node_modules/.bin/codex");
    if ((await NodeFSP.realpath(command)) !== (await NodeFSP.realpath(binary)))
      throw new Error("Dedicated Codex command does not match its runtime");
    await walk(".harness-provider/package-lock.json");
    await walk(".", NodePath.join(release, ".harness-provider", "node_modules", "@openai"));
  }
  return hash.digest("hex");
}

async function assertValidated(candidate: string, validation: Validation) {
  if (requiredUsages.some((usage) => validation.usages[usage] !== true)) {
    throw new Error("Missing required usage validation");
  }
  if (validation.fingerprint !== (await fingerprint(candidate)))
    throw new Error("Candidate changed after validation");
}

async function restore(
  paths: RuntimePaths,
  journal: Journal,
  control: RuntimeControl,
  allowStateRestore = false,
) {
  if (["activating", "rollback-activating"].includes(journal.phase) && !allowStateRestore)
    throw new Error("Admission may have occurred; automatic stop/restore refused. Run recover");
  await control.stop();
  const journalPath = NodePath.join(paths.operations, "promotion.json");
  if (journal.phase !== "stopping") {
    // Check backup readability before moving the current state out of the way.
    const backupDb = new NodeSqlite.DatabaseSync(
      NodePath.join(journal.backup, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      if (backupDb.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new Error("Backup SQLite is corrupt");
    } finally {
      backupDb.close();
    }
    assertIdle(journal.backup);
    const admitted = journal.phase === "activating";
    const exists = await NodeFSP.stat(paths.home).then(
      () => true,
      (error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        return false;
      },
    );
    if (exists) {
      const preserved = NodePath.join(paths.operations, "preserved", NodeCrypto.randomUUID());
      await NodeFSP.cp(paths.home, preserved, { recursive: true, preserveTimestamps: true });
      journal.preservedStates = [...(journal.preservedStates ?? []), preserved];
      await writeJson(journalPath, journal);
      if (admitted && !allowStateRestore)
        throw new Error(
          "Candidate admission may have occurred; state preserved. Explicit snapshot restoration required",
        );
      if (
        journal.phase === "committed" &&
        !allowStateRestore &&
        journal.committedState !== (await stateDigest(paths.home))
      ) {
        await control.start();
        throw new Error(
          "State changed since promotion; current state preserved. Explicit --restore-snapshot required",
        );
      }
    }
    journal.phase = "restoring";
    await writeJson(journalPath, journal);
    const restored = `${paths.home}.restored`;
    await NodeFSP.rm(restored, { recursive: true, force: true });
    await NodeFSP.cp(journal.backup, restored, { recursive: true, preserveTimestamps: true });
    const failed = NodePath.join(
      paths.operations,
      "preserved",
      `displaced-${NodeCrypto.randomUUID()}`,
    );
    await NodeFSP.mkdir(NodePath.dirname(failed), { recursive: true, mode: 0o700 });
    await NodeFSP.rename(paths.home, failed).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await NodeFSP.rename(restored, paths.home);
  }
  journal.phase = "restoring";
  await writeJson(journalPath, journal);
  await switchRelease(paths.operations, journal.previous);
  journal.phase = "restored";
  await writeJson(journalPath, journal);
  await control.start();
  await control.check();
  journal.phase = "rollback-activating";
  await writeJson(journalPath, journal);
  await control.activate();
  await control.ready(journal.id);
  journal.phase = "rolled-back";
  await writeJson(journalPath, journal);
}

export async function recover(paths: RuntimePaths, control: RuntimeControl) {
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(paths.operations, "promotion.json"), "utf8"),
  ) as Journal;
  if (journal.phase === "quiescing") {
    await control.releaseQuiescence(journal.id);
    journal.phase = "rolled-back";
    await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    return;
  }
  if (journal.phase === "committed" || journal.phase === "rolled-back") {
    if (journal.rollbackLease) await control.releaseQuiescence(journal.rollbackLease);
    return;
  }
  if (["activating", "rollback-activating"].includes(journal.phase)) {
    const rollback = journal.phase === "rollback-activating";
    // Activation was decided durably. Replay it without stopping a possibly busy host.
    await control.start();
    await control.check();
    await control.activate();
    await control.ready(journal.id);
    journal.committedState = await stateDigest(paths.home);
    journal.phase = rollback ? "rolled-back" : "committed";
    await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    return;
  }
  await restore(paths, journal, control);
}

/** Explicit operator rollback remains available after a successful promotion. */
export async function rollback(
  paths: RuntimePaths,
  control: RuntimeControl,
  allowStateRestore = false,
) {
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(paths.operations, "promotion.json"), "utf8"),
  ) as Journal;
  if (journal.phase !== "committed" && !(allowStateRestore && journal.phase === "activating"))
    throw new Error("No committed promotion to roll back");
  assertIdle(paths.home);
  journal.rollbackLease = NodeCrypto.randomUUID();
  await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
  await control.quiesce(journal.rollbackLease);
  await control.stop();
  try {
    assertIdle(paths.home);
  } catch (error) {
    await control.start();
    throw error;
  }
  await restore(paths, journal, control, allowStateRestore);
}

export async function promote(
  paths: RuntimePaths,
  candidate: string,
  validation: Validation,
  control: RuntimeControl,
) {
  return withLock(paths.operations, async () => {
    await assertValidated(candidate, validation);
    assertIdle(paths.home);
    const previous = await currentRelease(paths.operations);
    if (previous === candidate) throw new Error("Candidate is already running");
    const journalPath = NodePath.join(paths.operations, "promotion.json");
    // A prior failed rollback must be recovered before a new attempt can replace its journal.
    try {
      const pending = JSON.parse(await NodeFSP.readFile(journalPath, "utf8")) as Journal;
      if (!["committed", "rolled-back"].includes(pending.phase))
        throw new Error("Recover the pending promotion first");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const backup = NodePath.join(paths.operations, "backups", NodeCrypto.randomUUID());
    const journal: Journal = {
      id: NodeCrypto.randomUUID(),
      phase: "quiescing",
      previous,
      candidate,
      backup,
    };
    await writeJson(journalPath, journal);
    try {
      await control.quiesce(journal.id);
      assertIdle(paths.home);
      journal.phase = "stopping";
      await writeJson(journalPath, journal);
      await control.stop();
      // Close the admission race with messages and the persistent scheduler before backing up.
      assertIdle(paths.home);
      await NodeFSP.cp(paths.home, backup, { recursive: true, preserveTimestamps: true });
      journal.phase = "backed-up";
      await writeJson(journalPath, journal);
      journal.phase = "switching";
      await writeJson(journalPath, journal);
      await switchRelease(paths.operations, candidate);
      journal.phase = "switched";
      await writeJson(journalPath, journal);
      await control.start();
      await control.check();
      journal.phase = "activating";
      await writeJson(journalPath, journal);
      await control.activate();
      await control.ready(journal.id);
      journal.committedState = await stateDigest(paths.home);
      journal.phase = "committed";
      await writeJson(journalPath, journal);
    } catch (error) {
      if (journal.phase === "quiescing") {
        await control.releaseQuiescence(journal.id);
        journal.phase = "rolled-back";
        await writeJson(journalPath, journal);
      } else if (journal.phase !== "activating") await restore(paths, journal, control);
      throw error;
    }
  });
}
