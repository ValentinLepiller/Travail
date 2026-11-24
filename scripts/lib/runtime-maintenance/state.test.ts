// @effect-diagnostics nodeBuiltinImport:off - Isolated SQLite and filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import {
  captureCommittedState,
  matchesCommittedState,
  restoreState,
  snapshotState,
  stateDigest,
} from "./state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "travail-state-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const backup = NodePath.join(root, "backup");
  const userdata = NodePath.join(home, "userdata");
  await NodeFSP.mkdir(userdata, { recursive: true });
  const database = NodePath.join(userdata, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(
    "CREATE TABLE task (id INTEGER PRIMARY KEY, note TEXT, data BLOB); INSERT INTO task VALUES (9007199254740993,'original',x'12');",
  );
  db.close();
  return { root, home, backup, userdata, database };
}

it("clones only migration inputs and restores them while keeping current user files", async () => {
  const f = await fixture();
  const excluded = [
    "worktrees/project/branch",
    "codex/sessions/chat",
    "userdata/attachments/photo",
    "userdata/secrets/key",
    "userdata/logs/server.log",
  ];
  for (const file of excluded) {
    const path = NodePath.join(f.home, file);
    await NodeFSP.mkdir(NodePath.join(path, ".."), { recursive: true });
    await NodeFSP.writeFile(path, "before");
  }
  await snapshotState(f.home, f.backup);
  expect(await NodeFSP.readdir(NodePath.join(f.backup, "userdata"))).toEqual(["statev2.sqlite"]);
  expect((await NodeFSP.readdir(f.backup)).sort()).toEqual(["snapshot.json", "userdata"]);
  for (const file of excluded) await NodeFSP.writeFile(NodePath.join(f.home, file), "after");
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec("UPDATE task SET note='migrated'");
  db.close();
  await NodeFSP.writeFile(NodePath.join(f.userdata, "settings.json"), "new");
  await restoreState(f.home, f.backup, true);
  const restored = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
  try {
    expect(restored.prepare("SELECT note FROM task").get()?.note).toBe("original");
  } finally {
    restored.close();
  }
  for (const file of excluded)
    expect(await NodeFSP.readFile(NodePath.join(f.home, file), "utf8")).toBe("after");
  await expect(NodeFSP.stat(NodePath.join(f.userdata, "settings.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("captures committed WAL frames before admission and notices subsequent work", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE task SET note='prepared'",
    );
    const marker = await captureCommittedState(f.home, f.backup);
    expect(await matchesCommittedState(f.home, f.backup, marker)).toBe(true);
    db.exec("INSERT INTO task(note) VALUES ('user accepted')");
    expect(await matchesCommittedState(f.home, f.backup, marker)).toBe(false);
    expect(await matchesCommittedState(f.home, f.backup, "old-global-hash")).toBe(false);
  } finally {
    db.close();
  }
});

it("rejects missing or truncated scoped snapshots before touching the current files", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(NodePath.join(f.userdata, "settings.json"), "previous");
  await snapshotState(f.home, f.backup);
  await NodeFSP.writeFile(NodePath.join(f.userdata, "settings.json"), "keep");
  await NodeFSP.truncate(NodePath.join(f.backup, "userdata/statev2.sqlite"), 100);
  await expect(restoreState(f.home, f.backup, true)).rejects.toThrow("Incomplete state snapshot");
  await NodeFSP.unlink(NodePath.join(f.backup, "snapshot.json"));
  await expect(restoreState(f.home, f.backup, true)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await NodeFSP.readFile(NodePath.join(f.userdata, "settings.json"), "utf8")).toBe("keep");
});

it("clones a large sparse file without a dense fallback on unsupported filesystems", async () => {
  const f = await fixture();
  await NodeFSP.truncate(f.database, 64 * 1024 * 1024);
  const supportsReflink = await NodeFSP.copyFile(
    f.database,
    NodePath.join(f.root, "probe"),
    NodeFS.constants.COPYFILE_FICLONE_FORCE,
  ).then(
    () => true,
    () => false,
  );
  if (!supportsReflink) {
    await expect(snapshotState(f.home, f.backup)).rejects.toThrow("A reflink is required");
    await expect(NodeFSP.stat(NodePath.join(f.backup, "snapshot.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    return;
  }
  await snapshotState(f.home, f.backup);
  const stat = await NodeFSP.stat(NodePath.join(f.backup, "userdata/statev2.sqlite"));
  expect(stat.size).toBe(64 * 1024 * 1024);
  expect(stat.blocks * 512).toBeLessThan(stat.size);
});

it("protects row identities and distinguishes blob, null and text values", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  try {
    db.exec("CREATE TABLE entries(note); INSERT INTO entries(rowid,note) VALUES(1,NULL)");
    const states = [await stateDigest(f.home)];
    for (const sql of [
      "UPDATE entries SET rowid=2",
      "UPDATE entries SET note=x'6e756c6c'",
      "UPDATE entries SET note='null'",
    ]) {
      db.exec(sql);
      states.push(await stateDigest(f.home));
    }
    expect(new Set(states).size).toBe(states.length);
  } finally {
    db.close();
  }
});
