// @effect-diagnostics nodeBuiltinImport:off - Real filesystem and SQLite fixtures, never daily state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { AdmissionUnavailable } from "./quiescence.ts";
import { afterEach, expect, it } from "vite-plus/test";
import {
  fingerprint,
  promote,
  recover,
  requiredUsages,
  rollback,
  type RuntimeControl,
} from "./promotion.ts";
import {
  assertIdle,
  currentRelease,
  switchRelease,
  stateDigest,
  withLock,
  writeJson,
} from "./state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-maintenance-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const operations = NodePath.join(root, "operations");
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  await NodeFSP.mkdir(operations);
  const database = NodePath.join(home, "userdata", "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_runs (status TEXT);
    CREATE TABLE orchestration_v2_effect_outbox (status TEXT);
    CREATE TABLE orchestration_v2_thread_launch_workflows (status TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (status TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (status TEXT);
    CREATE TABLE orchestration_v2_projection_provider_turns (status TEXT);
    CREATE TABLE scheduled_tasks (id TEXT, enabled INTEGER, last_run_status TEXT);
    INSERT INTO scheduled_tasks VALUES ('morning', 1, 'succeeded');
  `);
  db.close();
  const settings = NodePath.join(home, "userdata", "settings.json");
  await NodeFSP.writeFile(settings, '{"preserve":"original"}');
  async function release(name: string) {
    const directory = NodePath.join(root, name);
    for (const [relative, body] of [
      ["apps/server/package.json", '{"dependencies":{}}'],
      ["apps/server/dist/bin.mjs", name],
      ["apps/desktop/dist-electron/main.cjs", name],
      ["apps/desktop/dist-electron/chunks/preload.cjs", name],
      ["apps/server/src/cloud/serviceProtocol.ts", "protocol"],
      ["scripts/harness-runtime.ts", "controller"],
      ["scripts/lib/runtime-maintenance/state.ts", "snapshot"],
      ["scripts/harness.ts", "launcher"],
      ["scripts/lib/codex-home.ts", "private bootstrap"],
      ["scripts/lib/harness-home.ts", "bootstrap"],
      ["pnpm-lock.yaml", "dependencies"],
    ]) {
      const file = NodePath.join(directory, relative!);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(file, body!);
    }
    return directory;
  }
  const previous = await release("previous");
  const candidate = await release("candidate");
  await switchRelease(operations, previous);
  const validation = {
    fingerprint: await fingerprint(candidate),
    usages: Object.fromEntries(requiredUsages.map((usage) => [usage, true])) as Record<
      (typeof requiredUsages)[number],
      boolean
    >,
  };
  const events: string[] = [];
  const control: RuntimeControl = {
    quiesce: async () => {},
    releaseQuiescence: async () => {},
    guardRecoveryStop: async () => {},
    activate: async () => {},
    ready: async () => {},
    stop: async () => {
      events.push("stop");
    },
    start: async () => {
      events.push("start");
    },
    check: async () => {
      events.push("check");
    },
  };
  return { home, operations, database, settings, previous, candidate, validation, control, events };
}

it("refuses incomplete validation before disturbing the host", async () => {
  const f = await fixture();
  f.validation.usages.voice = false;
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "Missing required",
  );
  expect(f.events).toEqual([]);
  expect(await currentRelease(f.operations)).toBe(f.previous);
});

it.each([
  "apps/server/dist/bin.mjs",
  "apps/desktop/dist-electron/main.cjs",
  "apps/desktop/dist-electron/chunks/preload.cjs",
])("rejects an executable changed after validation: %s", async (entry) => {
  const f = await fixture();
  await NodeFSP.writeFile(NodePath.join(f.candidate, entry), "changed");
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow("changed after");
  expect(f.events).toEqual([]);
});

it.each([
  ["orchestration_v2_projection_runs", "waiting"],
  ["orchestration_v2_projection_runs", "queued"],
  ["orchestration_v2_effect_outbox", "pending"],
  ["orchestration_v2_projection_subagents", "running"],
  ["orchestration_v2_projection_runtime_requests", "pending"],
  ["orchestration_v2_projection_provider_turns", "starting"],
  ["orchestration_v2_thread_launch_workflows", "preparing"],
])("preserves work in %s (%s) without stopping it", async (table, status) => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.prepare(`INSERT INTO ${table} VALUES (?)`).run(status);
  db.close();
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "Active or pending",
  );
  expect(f.events).toEqual([]);
});

it("blocks a running scheduled task and an unreadable database", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec("UPDATE scheduled_tasks SET last_run_status = 'running'");
  db.close();
  expect(() => assertIdle(f.home)).toThrow("Active or pending");
  await NodeFSP.rm(f.database);
  expect(() => assertIdle(f.home)).toThrow();
});

it("rechecks work admitted immediately before shutdown, then resumes the previous host", async () => {
  const f = await fixture();
  let stops = 0;
  f.control.stop = async () => {
    if (stops++ === 0) {
      const db = new NodeSqlite.DatabaseSync(f.database);
      db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('queued')");
      db.close();
    }
  };
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "Active or pending",
  );
  expect(await currentRelease(f.operations)).toBe(f.previous);
  expect(f.events).toEqual(["start", "check"]);
});

it("promotes an idle validated host and keeps a usable state backup", async () => {
  const f = await fixture();
  await promote(f, f.candidate, f.validation, f.control);
  expect(await currentRelease(f.operations)).toBe(f.candidate);
  expect(f.events).toEqual(["stop", "start", "check"]);
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.operations, "promotion.json"), "utf8"),
  );
  expect(journal.phase).toBe("committed");
  expect(
    await NodeFSP.readFile(NodePath.join(journal.backup, "userdata", "settings.json"), "utf8"),
  ).toBe('{"preserve":"original"}');
});

it("restores the previous executable, settings and persisted tasks after a failed migration", async () => {
  const f = await fixture();
  f.control.start = async () => {
    if ((await currentRelease(f.operations)) === f.candidate) {
      const db = new NodeSqlite.DatabaseSync(f.database);
      db.exec(
        "ALTER TABLE scheduled_tasks ADD COLUMN new_schema TEXT; UPDATE scheduled_tasks SET enabled = 0",
      );
      db.close();
      await NodeFSP.writeFile(f.settings, '{"changed":true}');
    }
  };
  f.control.check = async () => {
    if ((await currentRelease(f.operations)) === f.candidate) throw new Error("bad migration");
  };
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow("bad migration");
  expect(await currentRelease(f.operations)).toBe(f.previous);
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe('{"preserve":"original"}');
  const db = new NodeSqlite.DatabaseSync(f.database);
  expect(db.prepare("SELECT * FROM scheduled_tasks").all()).toEqual([
    { id: "morning", enabled: 1, last_run_status: "succeeded" },
  ]);
  db.close();
});

it("resumes the previous release after an interrupted backup without ever restoring its partial files", async () => {
  const f = await fixture();
  const journalPath = NodePath.join(f.operations, "promotion.json");
  const backup = NodePath.join(f.operations, "partial");
  await NodeFSP.mkdir(NodePath.join(backup, "userdata"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(backup, "userdata", "statev2.sqlite"), "partial");
  await writeJson(journalPath, {
    id: "backup-crash",
    phase: "stopping",
    previous: f.previous,
    candidate: f.candidate,
    backup,
  });
  // This temporary link would block a needless switch back to the already current release.
  await NodeFSP.mkdir(NodePath.join(f.operations, "current.next"));
  f.control.start = async () => {
    throw new Error("interrupted start");
  };
  await expect(recover(f, f.control)).rejects.toThrow("interrupted start");
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8")).phase).toBe("restored");
  f.control.start = async () => {};
  await recover(f, f.control);
  assertIdle(f.home);
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8")).phase).toBe("rolled-back");
});

it("reopens the intact previous home when an old stopping path wrote restoring before a crash", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(f.settings, "user's latest work");
  f.control.stop = async () => {
    throw new Error("Unexpected stop");
  };
  const journalPath = NodePath.join(f.operations, "promotion.json");
  await writeJson(journalPath, {
    id: "old-stopping",
    phase: "restoring",
    previous: f.previous,
    candidate: f.candidate,
    backup: "incomplete",
  });
  await recover(f, f.control);
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8")).phase).toBe("rolled-back");
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe("user's latest work");
});

it("finishes a partial database replacement only after confirming the runtime remains stopped", async () => {
  const f = await fixture();
  const backup = NodePath.join(f.operations, "backup");
  await NodeFSP.cp(f.home, backup, { recursive: true });
  await writeJson(NodePath.join(f.operations, "promotion.json"), {
    id: "restore-crash",
    phase: "restoring",
    previous: f.previous,
    candidate: f.candidate,
    backup,
  });
  await switchRelease(f.operations, f.candidate);
  await NodeFSP.writeFile(f.database, "partial");
  f.control.guardRecoveryStop = async (_, requireStopped) => {
    expect(requireStopped).toBe(true);
    throw new Error("running");
  };
  await expect(recover(f, f.control)).rejects.toThrow("running");
  expect(f.events).toEqual([]);
  f.control.guardRecoveryStop = async (_, requireStopped) => {
    expect(requireStopped).toBe(true);
  };
  await recover(f, f.control);
  assertIdle(f.home);
});

it("recovers an interrupted state restore without needing the new app to start", async () => {
  const f = await fixture();
  const backup = NodePath.join(f.operations, "backup");
  await NodeFSP.cp(f.home, backup, { recursive: true });
  await NodeFSP.rm(f.home, { recursive: true });
  await switchRelease(f.operations, f.candidate);
  await writeJson(NodePath.join(f.operations, "promotion.json"), {
    phase: "restoring",
    previous: f.previous,
    candidate: f.candidate,
    backup,
  });
  await recover(f, f.control);
  expect(await currentRelease(f.operations)).toBe(f.previous);
  expect(() => assertIdle(f.home)).not.toThrow();
  await recover(f, f.control);
  expect(f.events).toEqual(["stop", "start", "check"]);
});

it("refuses destructive restoration from an unreadable backup", async () => {
  const f = await fixture();
  await writeJson(NodePath.join(f.operations, "promotion.json"), {
    phase: "switched",
    previous: f.previous,
    candidate: f.candidate,
    backup: NodePath.join(f.operations, "missing"),
  });
  await expect(recover(f, f.control)).rejects.toThrow();
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe('{"preserve":"original"}');
});

it("reopens a host stopped by an interrupted explicit rollback before any restore", async () => {
  const f = await fixture();
  await switchRelease(f.operations, f.candidate);
  const journalPath = NodePath.join(f.operations, "promotion.json");
  await writeJson(journalPath, {
    id: "promotion",
    phase: "committed",
    previous: f.previous,
    candidate: f.candidate,
    backup: "untouched",
    rollbackLease: "rollback",
  });
  f.control.releaseQuiescence = async (id) => {
    expect(id).toBe("rollback");
    f.events.push("release");
  };
  await recover(f, f.control);
  await recover(f, f.control);
  expect(f.events).toEqual(["start", "release"]);
  expect(await currentRelease(f.operations)).toBe(f.candidate);
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8"))).not.toHaveProperty(
    "rollbackLease",
  );
});

it("supports explicit rollback after a completed promotion", async () => {
  const f = await fixture();
  await promote(f, f.candidate, f.validation, f.control);
  await rollback(f, f.control);
  expect(await currentRelease(f.operations)).toBe(f.previous);
});

it("serializes maintenance attempts and releases its lock on failure", async () => {
  const f = await fixture();
  await withLock(f.operations, async () => {
    await expect(withLock(f.operations, async () => undefined)).rejects.toThrow();
  });
  await expect(
    withLock(f.operations, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  await withLock(f.operations, async () => undefined);
});

it("rejects an incomplete dedicated Codex installation", async () => {
  const f = await fixture();
  await NodeFSP.mkdir(NodePath.join(f.candidate, ".harness-provider"));
  await expect(fingerprint(f.candidate)).rejects.toThrow();
});

it("seals external native dependency files as well as the bundle", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(f.candidate, "apps/server/package.json"),
    '{"dependencies":{"node-pty":"1.0.0"}}',
  );
  const dependency = NodePath.join(f.candidate, "apps/server/node_modules/node-pty");
  await NodeFSP.mkdir(dependency, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dependency, "package.json"),
    '{"name":"node-pty","version":"1.0.0"}',
  );
  await NodeFSP.writeFile(NodePath.join(dependency, "native.node"), "validated");
  f.validation.fingerprint = await fingerprint(f.candidate);
  await NodeFSP.writeFile(NodePath.join(dependency, "native.node"), "changed");
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow("changed after");
  expect(f.events).toEqual([]);
});

it("preserves evolved state and requires explicit consent to restore an older snapshot", async () => {
  const f = await fixture();
  await promote(f, f.candidate, f.validation, f.control);
  await NodeFSP.writeFile(f.settings, '{"newWork":"must not disappear"}');
  await expect(rollback(f, f.control)).rejects.toThrow("Explicit --restore-snapshot");
  expect(await currentRelease(f.operations)).toBe(f.candidate);
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe('{"newWork":"must not disappear"}');
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.operations, "promotion.json"), "utf8"),
  );
  expect(
    await NodeFSP.readFile(
      NodePath.join(journal.preservedStates[0], "userdata/settings.json"),
      "utf8",
    ),
  ).toBe('{"newWork":"must not disappear"}');
  await rollback(f, f.control, true);
  expect(await currentRelease(f.operations)).toBe(f.previous);
  expect(
    await NodeFSP.readFile(
      NodePath.join(journal.preservedStates[0], "userdata/settings.json"),
      "utf8",
    ),
  ).toBe('{"newWork":"must not disappear"}');
});

it("allows recovery after a kernel lock holder is killed and leaves its stale file", async () => {
  const f = await fixture();
  const child = NodeChildProcess.spawn(
    "/usr/bin/flock",
    [
      "--no-fork",
      "--exclusive",
      "--nonblock",
      NodePath.join(f.operations, "maintenance.lock"),
      process.execPath,
      "--eval",
      'process.send("locked"); process.stdin.resume()',
    ],
    { stdio: ["pipe", "ignore", "ignore", "ipc"] },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Lock fixture exited early")));
  });
  await expect(withLock(f.operations, async () => undefined)).rejects.toThrow("held");
  child.kill("SIGKILL");
  await exited;
  await withLock(f.operations, async () => undefined);
});

it("digests WITHOUT ROWID tables deterministically and detects later logical changes", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec(
    "CREATE TABLE reviewed (repo TEXT, path TEXT, stamp TEXT, PRIMARY KEY(repo,path)) WITHOUT ROWID; INSERT INTO reviewed VALUES ('repo','file','before')",
  );
  db.close();
  const before = await stateDigest(f.home);
  expect(await stateDigest(f.home)).toBe(before);
  const changed = new NodeSqlite.DatabaseSync(f.database);
  changed.exec("UPDATE reviewed SET stamp = 'after'");
  changed.close();
  expect(await stateDigest(f.home)).not.toBe(before);
});

it("leaves admitted work running when readiness fails and replays activation without stopping it", async () => {
  const f = await fixture();
  f.control.activate = async () => {
    await NodeFSP.writeFile(f.settings, '{"admitted":"preserved"}');
  };
  f.control.ready = async () => {
    throw new Error("ready probe failed");
  };
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "ready probe failed",
  );
  expect(f.events).toEqual(["stop", "start", "check"]);
  expect(await currentRelease(f.operations)).toBe(f.candidate);
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(f.operations, "promotion.json"), "utf8"),
  );
  expect(journal.phase).toBe("activating");
  f.events.length = 0;
  f.control.ready = async () => {};
  await recover(f, f.control);
  expect(f.events).toEqual(["start", "check"]);
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe('{"admitted":"preserved"}');
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(f.operations, "promotion.json"), "utf8")).phase,
  ).toBe("committed");
  await expect(rollback(f, f.control)).rejects.toThrow("Explicit --restore-snapshot");
  expect(await NodeFSP.readFile(f.settings, "utf8")).toBe('{"admitted":"preserved"}');
});

it("leaves queued work untouched when an old pre-activation journal asks for recovery", async () => {
  const f = await fixture();
  await switchRelease(f.operations, f.candidate);
  await writeJson(NodePath.join(f.operations, "promotion.json"), {
    phase: "switched",
    id: "orphan",
    previous: f.previous,
    candidate: f.candidate,
    backup: "old",
  });
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('queued')");
  db.close();
  await expect(recover(f, f.control)).rejects.toThrow("Active or pending");
  expect(f.events).toEqual([]);
  expect(await currentRelease(f.operations)).toBe(f.candidate);
});

it("finishes a legacy rollback activation without stopping or restoring a busy previous host", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('running')");
  db.close();
  const journalPath = NodePath.join(f.operations, "promotion.json");
  await writeJson(journalPath, {
    id: "legacy",
    phase: "rollback-activating",
    previous: f.previous,
    candidate: f.candidate,
    backup: "unused",
  });
  f.control.ready = async (id) => {
    expect(id).toBe("legacy");
    f.events.push("ready");
  };
  await recover(f, f.control);
  expect(f.events).toEqual(["start", "check", "ready"]);
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8"))).toMatchObject({
    phase: "rolled-back",
  });
  expect(() => assertIdle(f.home)).toThrow("Active or pending");
});

it("leaves an activation journal intact when current points to another release", async () => {
  const f = await fixture();
  const journalPath = NodePath.join(f.operations, "promotion.json");
  const journal = {
    id: "stale",
    phase: "rollback-activating",
    previous: f.previous,
    candidate: f.candidate,
    backup: "unused",
  };
  await writeJson(journalPath, journal);
  await switchRelease(f.operations, f.candidate);
  await expect(recover(f, f.control)).rejects.toThrow("activation target");
  expect(f.events).toEqual([]);
  expect(JSON.parse(await NodeFSP.readFile(journalPath, "utf8"))).toEqual(journal);
});

it("rejects an executable protocol source changed after validation", async () => {
  const f = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(f.candidate, "apps/server/src/cloud/serviceProtocol.ts"),
    "changed",
  );
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow("changed after");
  expect(f.events).toEqual([]);
});

it.each([false, true])(
  "preserves durable work across a planned agent restart, including rollback (failed start: %s)",
  async (failedStart) => {
    const f = await fixture();
    const db = new NodeSqlite.DatabaseSync(f.database);
    db.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('running')");
    db.close();
    f.control.quiesce = async (_id, restartAgents) => {
      expect(restartAgents).toBe(true);
    };
    const check = f.control.check;
    f.control.check = async () => {
      if (failedStart && (await currentRelease(f.operations)) === f.candidate)
        throw new Error("Candidate failed to initialize");
      await check();
    };
    const install = promote(f, f.candidate, f.validation, f.control, f.previous, true);
    if (failedStart) await expect(install).rejects.toThrow("Candidate failed");
    else await install;
    expect(await currentRelease(f.operations)).toBe(failedStart ? f.previous : f.candidate);
    const persisted = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
    try {
      expect(
        persisted.prepare("SELECT status FROM orchestration_v2_projection_runs").get()?.status,
      ).toBe("running");
    } finally {
      persisted.close();
    }
  },
);

it("never stops the host if admission quiescence is unavailable or busy", async () => {
  const f = await fixture();
  f.control.quiesce = async () => {
    throw new Error("active voice or desktops");
  };
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "active voice or desktops",
  );
  expect(f.events).toEqual([]);
  expect(await currentRelease(f.operations)).toBe(f.previous);
});

it("rejects a legacy bootstrap without an admission endpoint and leaves the old host usable", async () => {
  const f = await fixture();
  f.control.quiesce = async () => {
    throw new AdmissionUnavailable("Unsupported endpoint");
  };
  f.control.releaseQuiescence = async () => {
    throw new Error("Unexpected release");
  };
  await expect(promote(f, f.candidate, f.validation, f.control)).rejects.toThrow(
    "Unsupported endpoint",
  );
  expect(f.events).toEqual([]);
  expect(await currentRelease(f.operations)).toBe(f.previous);
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(f.operations, "promotion.json"), "utf8")).phase,
  ).toBe("rolled-back");
});

it("releases an orphaned acquisition without stopping active work", async () => {
  const f = await fixture();
  await writeJson(NodePath.join(f.operations, "promotion.json"), {
    id: "orphan",
    phase: "quiescing",
    previous: f.previous,
    candidate: f.candidate,
    backup: "unused",
  });
  const releases: string[] = [];
  f.control.releaseQuiescence = async (id) => {
    releases.push(id);
  };
  await recover(f, f.control);
  expect(releases).toEqual(["orphan"]);
  expect(f.events).toEqual([]);
});

it("ignores its temporary probe grants but preserves protection for real client credentials", async () => {
  const f = await fixture();
  const db = new NodeSqlite.DatabaseSync(f.database);
  db.exec(
    "CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY,subject TEXT); INSERT INTO auth_sessions VALUES ('user','browser')",
  );
  db.close();
  const before = await stateDigest(f.home);
  const probe = new NodeSqlite.DatabaseSync(f.database);
  probe.exec("INSERT INTO auth_sessions VALUES ('probe','harness-maintenance-probe')");
  probe.close();
  expect(await stateDigest(f.home)).toBe(before);
  const client = new NodeSqlite.DatabaseSync(f.database);
  client.exec("INSERT INTO auth_sessions VALUES ('new-client','browser')");
  client.close();
  expect(await stateDigest(f.home)).not.toBe(before);
});
