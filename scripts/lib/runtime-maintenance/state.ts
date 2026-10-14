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

/** Stable logical state digest ignores SQLite WAL/checkpoint layout while detecting accepted work. */
export async function stateDigest(home: string) {
  const hash = NodeCrypto.createHash("sha256");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    db.exec("BEGIN");
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    for (const table of tables) {
      hash.update(JSON.stringify(table));
      const name = String(table.name).replaceAll('"', '""');
      const primaryKey = db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => `"${String(column.name).replaceAll('"', '""')}"`);
      const order = primaryKey.length > 0 ? primaryKey.join(",") : "rowid";
      const filter =
        table.name === "auth_sessions" ? "WHERE subject <> 'harness-maintenance-probe'" : "";
      for (const row of db.prepare(`SELECT * FROM "${name}" ${filter} ORDER BY ${order}`).iterate())
        hash.update(JSON.stringify(row));
    }
  } finally {
    db.close();
  }
  async function walk(relative: string) {
    const path = NodePath.join(home, relative);
    const stat = await NodeFSP.lstat(path);
    if (stat.isSymbolicLink()) {
      hash.update(relative + (await NodeFSP.readlink(path)));
      return;
    }
    if (stat.isDirectory()) {
      for (const name of (await NodeFSP.readdir(path)).sort())
        await walk(NodePath.join(relative, name));
      return;
    }
    if (/statev2\.sqlite(?:-wal|-shm)?$/.test(relative)) return;
    hash.update(relative);
    for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  }
  await walk(".");
  return hash.digest("hex");
}
