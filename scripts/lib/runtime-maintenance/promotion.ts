// @effect-diagnostics nodeBuiltinImport:off - Transaction/recovery filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { AdmissionUnavailable } from "./quiescence.ts";
import { runtimePackages } from "./dependencies.ts";
import {
  assertIdle,
  currentRelease,
  switchRelease,
  lstatIfPresent,
  snapshotState,
  captureCommittedState,
  matchesCommittedState,
  restoreState,
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
  /** Unknown running services must acquire admission before a recovery can stop them. */
  guardRecoveryStop(operationId: string, requireStopped: boolean): Promise<void>;
}
export interface RuntimePaths {
  readonly operations: string;
  readonly home: string;
}
interface Journal {
  id: string;
  rollbackLease?: string;
  committedState?: string;
  stateSnapshotVersion?: 2;
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
    "scripts/harness-runtime.ts",
    "scripts/lib/runtime-maintenance",
    "scripts/lib/harness-home.ts",
    "scripts/lib/codex-home.ts",
    "pnpm-lock.yaml",
    "apps/server/src/cloud/serviceProtocol.ts",
  ])
    await walk(entry);
  // Server-only releases have no Electron bundle. When present, seal every preload and chunk.
  const desktopBundle = "apps/desktop/dist-electron";
  const desktop = await NodeFSP.lstat(NodePath.join(release, desktopBundle)).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (desktop) await walk(desktopBundle);
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
    assertIdle(journal.backup);
    if (journal.phase !== "restoring" && (await lstatIfPresent(paths.home))) {
      const preserved = NodePath.join(paths.operations, "preserved", NodeCrypto.randomUUID());
      await snapshotState(paths.home, preserved);
      journal.preservedStates = [...(journal.preservedStates ?? []), preserved];
      await writeJson(journalPath, journal);
      if (
        journal.phase === "committed" &&
        !allowStateRestore &&
        !(await matchesCommittedState(paths.home, journal.backup, journal.committedState))
      ) {
        throw new Error(
          "State changed since promotion; current state preserved. Explicit --restore-snapshot required",
        );
      }
    }
    journal.phase = "restoring";
    await writeJson(journalPath, journal);
    await restoreState(
      paths.home,
      journal.backup,
      journal.stateSnapshotVersion === 2,
      journal.preservedStates?.at(-1),
    );
    await switchRelease(paths.operations, journal.previous);
  }
  // In stopping the previous release is still selected and its backup may be incomplete.
  journal.phase = "restored";
  await writeJson(journalPath, journal);
  await control.start();
  await control.check();
  journal.phase = "rollback-activating";
  await writeJson(journalPath, journal);
  await control.activate();
  await control.ready(journal.id);
  journal.phase = "rolled-back";
  delete journal.rollbackLease;
  await writeJson(journalPath, journal);
}

export async function recover(paths: RuntimePaths, control: RuntimeControl) {
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(paths.operations, "promotion.json"), "utf8"),
  ) as Journal;
  if (journal.phase === "quiescing") {
    if ((await currentRelease(paths.operations)) !== journal.previous)
      throw new Error("Current release does not match the journal quiescence target");
    await control.releaseQuiescence(journal.id);
    journal.phase = "rolled-back";
    await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    return;
  }
  if (journal.phase === "committed" || journal.phase === "rolled-back") {
    if (journal.rollbackLease) {
      const expected = journal.phase === "committed" ? journal.candidate : journal.previous;
      if ((await currentRelease(paths.operations)) !== expected)
        throw new Error("Current release does not match the interrupted rollback");
      // An explicit rollback can crash after stopping the admitted host and before restoring.
      await control.start();
      await control.releaseQuiescence(journal.rollbackLease);
      delete journal.rollbackLease;
      await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    }
    return;
  }
  // Old controllers briefly wrote "restoring" even when the first backup was interrupted.
  // The previous release and an intact home already agree, so replay only its activation.
  if (
    journal.phase === "restoring" &&
    journal.stateSnapshotVersion === undefined &&
    (await currentRelease(paths.operations)) === journal.previous
  ) {
    const currentHome = await NodeFSP.stat(paths.home).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (currentHome?.isDirectory()) {
      const database = await NodeFSP.stat(NodePath.join(paths.home, "userdata", "statev2.sqlite"));
      if (!database.isFile()) throw new Error("Previous runtime database is missing");
      journal.phase = "restored";
      await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    }
  }
  if (
    journal.phase === "activating" ||
    journal.phase === "rollback-activating" ||
    journal.phase === "restored"
  ) {
    const rollback = journal.phase !== "activating";
    if (
      (await currentRelease(paths.operations)) !== (rollback ? journal.previous : journal.candidate)
    )
      throw new Error("Current release does not match the journal activation target");
    // Activation was decided durably. Replay it without stopping a possibly busy host.
    await control.start();
    await control.check();
    if (journal.phase === "restored") {
      journal.phase = "rollback-activating";
      await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    }
    await control.activate();
    await control.ready(journal.id);
    journal.phase = rollback ? "rolled-back" : "committed";
    await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    return;
  }
  const current = await currentRelease(paths.operations);
  const expected = {
    stopping: [journal.previous],
    "backed-up": [journal.previous],
    switching: [journal.previous, journal.candidate],
    switched: [journal.candidate],
    restoring: [journal.previous, journal.candidate],
  }[journal.phase];
  if (!expected?.includes(current))
    throw new Error("Current release does not match the pending recovery phase");
  if (journal.phase !== "restoring") assertIdle(paths.home);
  await control.guardRecoveryStop(journal.id, journal.phase === "restoring");
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
  if ((await currentRelease(paths.operations)) !== journal.candidate)
    throw new Error("Current release does not match the rollback target");
  assertIdle(paths.home);
  journal.rollbackLease = NodeCrypto.randomUUID();
  await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
  await control.quiesce(journal.rollbackLease);
  await control.stop();
  try {
    assertIdle(paths.home);
    await restore(paths, journal, control, allowStateRestore);
  } catch (error) {
    if (journal.phase === "committed" || journal.phase === "activating") {
      await control.start();
      await control.releaseQuiescence(journal.rollbackLease);
      delete journal.rollbackLease;
      await writeJson(NodePath.join(paths.operations, "promotion.json"), journal);
    }
    throw error;
  }
}

export async function promote(
  paths: RuntimePaths,
  candidate: string,
  validation: Validation,
  control: RuntimeControl,
  expectedPrevious?: string,
) {
  return withLock(paths.operations, async () => {
    await assertValidated(candidate, validation);
    assertIdle(paths.home);
    const previous = await currentRelease(paths.operations);
    if (expectedPrevious !== undefined && previous !== expectedPrevious)
      throw new Error("The installed release changed during preparation");
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
      stateSnapshotVersion: 2,
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
      await snapshotState(paths.home, backup);
      journal.phase = "backed-up";
      await writeJson(journalPath, journal);
      journal.phase = "switching";
      await writeJson(journalPath, journal);
      await switchRelease(paths.operations, candidate);
      journal.phase = "switched";
      await writeJson(journalPath, journal);
      await control.start();
      await control.check();
      // After admission, even a readiness retry can observe work that rollback must preserve.
      journal.committedState = await captureCommittedState(paths.home, journal.backup);
      journal.phase = "activating";
      await writeJson(journalPath, journal);
      await control.activate();
      await control.ready(journal.id);
      journal.phase = "committed";
      await writeJson(journalPath, journal);
    } catch (error) {
      if (journal.phase === "quiescing") {
        if (!(error instanceof AdmissionUnavailable)) await control.releaseQuiescence(journal.id);
        journal.phase = "rolled-back";
        await writeJson(journalPath, journal);
      } else if (journal.phase !== "activating") await restore(paths, journal, control);
      throw error;
    }
  });
}
