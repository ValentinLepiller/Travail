// @effect-diagnostics nodeBuiltinImport:off - Independent recovery must work without MT's runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

export async function writeJson(path: string, value: unknown) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await NodeFSP.rename(temporary, path);
}

/** Kernel lock dies with its holder; PID reuse and stale files cannot strand recovery. */
export async function withLock<T>(operations: string, run: () => Promise<T>): Promise<T> {
  await NodeFSP.mkdir(operations, { recursive: true, mode: 0o700 });
  const holder = NodeChildProcess.spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      NodePath.join(operations, "maintenance.lock"),
      "/bin/sh",
      "-c",
      'printf "locked\\n"; cat >/dev/null',
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    holder.once("error", () => reject(new Error("Cannot acquire maintenance lock")));
    holder.once("close", () => reject(new Error("Maintenance lock is held by another process")));
    holder.stdout.once("data", () => resolve());
  });
  try {
    return await run();
  } finally {
    holder.stdin.end();
    await closed;
  }
}

/** Read a consistent snapshot. Unknown/missing schema blocks promotion rather than guessing idle. */
export function assertIdle(home: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    db.exec("BEGIN");
    const queries = [
      "SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs WHERE status IN ('queued','preparing','starting','running','waiting')",
      "SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running')",
      "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE last_run_status = 'running'",
      "SELECT COUNT(*) AS n FROM orchestration_v2_thread_launch_workflows WHERE status NOT IN ('completed','failed','cancelled')",
      "SELECT COUNT(*) AS n FROM orchestration_v2_projection_subagents WHERE status IN ('pending','starting','running','waiting')",
      "SELECT COUNT(*) AS n FROM orchestration_v2_projection_runtime_requests WHERE status IN ('pending','waiting')",
      "SELECT COUNT(*) AS n FROM orchestration_v2_projection_provider_turns WHERE status IN ('pending','starting','running','waiting')",
    ];
    for (const query of queries) {
      const result = db.prepare(query).get();
      if (result?.n !== 0) throw new Error("Active or pending work blocks maintenance");
    }
  } finally {
    db.close();
  }
}

export async function currentRelease(operations: string) {
  return NodeFSP.realpath(NodePath.join(operations, "current"));
}

export async function switchRelease(operations: string, release: string) {
  const temporary = NodePath.join(operations, "current.next");
  await NodeFSP.rm(temporary, { force: true });
  await NodeFSP.symlink(release, temporary);
  await NodeFSP.rename(temporary, NodePath.join(operations, "current"));
}

const databaseName = "statev2.sqlite";
const stateFiles = [
  databaseName,
  databaseName + "-wal",
  databaseName + "-journal",
  "settings.json",
] as const;
const committedSnapshot = "scoped-snapshot-v2";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function lstatIfPresent(path: string) {
  try {
    return await NodeFSP.lstat(path);
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}

async function stateDirectory(home: string) {
  const path = NodePath.join(home, "userdata");
  if (!(await NodeFSP.lstat(path)).isDirectory())
    throw new Error("Expected a real userdata directory");
  return path;
}

// A tiny state can also run on tmpfs or filesystems without reflinks. Never expand a large sparse database.
const maxDenseCopyBytes = 1024 * 1024;
type StateFiles = Record<string, number>;

function boundedFileCopy() {
  let denseBudget = maxDenseCopyBytes;
  return async (file: string, destination: string, size: number) => {
    try {
      await NodeFSP.copyFile(
        file,
        destination,
        NodeFS.constants.COPYFILE_FICLONE_FORCE | NodeFS.constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "ENOTTY", "EINVAL"].includes(
            String(error.code),
          )
        )
      )
        throw error;
      if (size > denseBudget)
        throw new Error(
          `A reflink is required to snapshot ${NodePath.basename(file)} on this filesystem`,
          {
            cause: error,
          },
        );
      denseBudget -= size;
      await NodeFSP.copyFile(file, destination, NodeFS.constants.COPYFILE_EXCL);
    }
  };
}

async function inspectStateFiles(source: string, expected?: StateFiles) {
  const files: StateFiles = {};
  for (const name of stateFiles) {
    const stat = await lstatIfPresent(NodePath.join(source, name));
    if (expected && stat?.size !== expected[name])
      throw new Error(`Incomplete state snapshot: ${name}`);
    if (!stat && name !== databaseName) continue;
    if (!stat?.isFile()) throw new Error(`Expected a regular state file: ${name}`);
    files[name] = stat.size;
  }
  return files;
}

async function copyStateFiles(source: string, output: string, expected?: StateFiles) {
  const files = await inspectStateFiles(source, expected);
  const copy = boundedFileCopy();
  for (const [name, size] of Object.entries(files)) {
    await copy(NodePath.join(source, name), NodePath.join(output, name), size);
  }
  return files;
}

/** Clone the migration inputs. Worktrees, attachments, credentials and provider homes stay in place. */
export async function snapshotState(home: string, destination: string) {
  const source = await stateDirectory(home);
  const output = NodePath.join(destination, "userdata");
  await NodeFSP.mkdir(output, { recursive: true, mode: 0o700 });
  const files = await copyStateFiles(source, output);
  await writeJson(NodePath.join(destination, "snapshot.json"), { version: 2, files });
}

async function snapshotManifest(backup: string): Promise<StateFiles> {
  const manifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(backup, "snapshot.json"), "utf8"),
  );
  if (
    manifest?.version !== 2 ||
    !manifest.files ||
    !Number.isSafeInteger(manifest.files[databaseName]) ||
    manifest.files[databaseName] <= 0
  )
    throw new Error("Invalid state snapshot manifest");
  return manifest.files;
}

/** The service is parked but SQLite can still checkpoint. Pin the WAL and hold out writers during the clone. */
export async function captureCommittedState(home: string, backup: string) {
  const file = NodePath.join(await stateDirectory(home), databaseName);
  if (!(await NodeFSP.lstat(file)).isFile()) throw new Error("Expected a regular SQLite database");
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    await snapshotState(home, backup + ".baseline");
  } finally {
    db.close();
  }
  return committedSnapshot;
}

export async function matchesCommittedState(home: string, backup: string, marker?: string) {
  // Older markers included every file under home. Never guess whether such a snapshot is safe.
  if (marker !== committedSnapshot) return false;
  const baseline = backup + ".baseline";
  await inspectStateFiles(await stateDirectory(baseline), await snapshotManifest(baseline));
  return (await stateDigest(home)) === (await stateDigest(baseline));
}

export async function restoreState(
  home: string,
  backup: string,
  scoped: boolean,
  legacyFullHome?: string,
) {
  const manifest = scoped ? await snapshotManifest(backup) : undefined;
  if (!(await lstatIfPresent(home))) {
    if (manifest)
      throw new Error(
        "Runtime home is missing; recover its user files before restoring the scoped snapshot",
      );
    // Old releases could crash after moving the entire home aside. Rebuild it privately before publishing.
    const temporary = await NodeFSP.mkdtemp(home + ".recover-");
    try {
      const copy = boundedFileCopy();
      await NodeFSP.cp(legacyFullHome ?? backup, temporary, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: async (src, dst) => {
          const stat = await NodeFSP.lstat(src);
          if (stat.isSymbolicLink() || stat.isDirectory()) return true;
          if (!stat.isFile()) throw new Error("Cannot restore a special file from a legacy home");
          await copy(src, dst, stat.size);
          await NodeFSP.utimes(dst, stat.atime, stat.mtime);
          return false;
        },
      });
      await NodeFSP.rename(temporary, home);
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  }
  const source = await stateDirectory(backup);
  const output = await stateDirectory(home);
  const staged = await NodeFSP.mkdtemp(NodePath.join(output, ".restore-"));
  try {
    const files = await copyStateFiles(source, staged, manifest);
    // The host is stopped, and a durable restoring journal makes this sequence replayable.
    for (const name of [...stateFiles, databaseName + "-shm"]) {
      const file = NodePath.join(output, name);
      if (Object.hasOwn(files, name)) await NodeFSP.rename(NodePath.join(staged, name), file);
      else await NodeFSP.rm(file, { force: true });
    }
  } finally {
    await NodeFSP.rm(staged, { recursive: true, force: true });
  }
}

/** Compared only for a requested rollback. Ignore physical WAL layout and temporary probe sessions. */
export async function stateDigest(home: string) {
  const hash = NodeCrypto.createHash("sha256");
  const directory = await stateDirectory(home);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, databaseName), {
    readOnly: true,
  });
  try {
    db.exec("BEGIN");
    hash.update(
      JSON.stringify([
        db.prepare("PRAGMA user_version").get(),
        db.prepare("PRAGMA application_id").get(),
      ]),
    );
    const withoutRowid = new Set(
      db
        .prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND wr=1")
        .all()
        .map((row) => row.name),
    );
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    for (const object of schema) {
      hash.update(JSON.stringify(object));
      if (object.type !== "table") continue;
      const name = String(object.name).replaceAll('"', '""');
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
      const rowid = withoutRowid.has(object.name)
        ? undefined
        : ["rowid", "_rowid_", "oid"].find(
            (alias) => !columns.some((column) => String(column.name).toLowerCase() === alias),
          );
      const order =
        rowid ??
        columns
          .filter((column) => Number(column.pk) > 0)
          .sort((a, b) => Number(a.pk) - Number(b.pk))
          .map((column) => `"${String(column.name).replaceAll('"', '""')}"`)
          .join(",");
      const filter =
        object.name === "auth_sessions" ? "WHERE subject IS NOT 'harness-maintenance-probe'" : "";
      const rows = db.prepare(
        `SELECT ${rowid ? rowid + ", " : ""}* FROM "${name}" ${filter} ${order ? "ORDER BY " + order : ""}`,
      );
      rows.setReadBigInts(true);
      rows.setReturnArrays(true);
      for (const row of rows.iterate()) {
        for (const value of Object.values(row)) {
          const data = value instanceof Uint8Array ? value : String(value);
          const tag = value === null ? "null" : typeof value;
          hash.update(tag + ":" + Buffer.byteLength(data) + ":");
          hash.update(data);
        }
      }
    }
  } finally {
    db.close();
  }
  const settings = NodePath.join(directory, "settings.json");
  const stat = await lstatIfPresent(settings);
  if (stat) {
    if (!stat.isFile()) throw new Error("Expected regular settings.json");
    hash.update("settings.json");
    hash.update(await NodeFSP.readFile(settings));
  }
  return hash.digest("hex");
}
