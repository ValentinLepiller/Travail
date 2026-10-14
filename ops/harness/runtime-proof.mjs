import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const ops = await NodeFSP.mkdtemp(NodePath.join(root, ".t3/runtime-proof-"));
const home = NodePath.join(ops, "home");
const node = await NodeFSP.realpath(process.execPath);
const config = {
  source: root,
  home: "fixture",
  operations: ops,
  port: 3773,
  timezone: "Europe/Paris",
  environmentId: "fixture",
  nativeCodex: NodePath.join(NodePath.dirname(node), "codex"),
  path: process.env.PATH,
  prepareUpdates: false,
  adaptWithAgent: false,
  promoteValidated: false,
  agentTimeoutMs: 1200000,
  commandTimeoutMs: 1200000,
  mt: { url: "https://github.com/munimtechnologies/mtcode.git", ref: "refs/heads/main" },
  t3: { url: "https://github.com/pingdotgg/t3code.git", ref: "refs/heads/main" },
  checks: {},
  postPromotionChecks: [],
};
const server = NodeNet.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await new Promise((r) => server.close(r));
Object.assign(config, { operations: ops, home, port, environmentId: "proof" });
await NodeFSP.writeFile(NodePath.join(ops, "config.json"), JSON.stringify(config));
await NodeFSP.symlink(root, NodePath.join(ops, "current"));
const id = NodeCrypto.randomUUID();
await NodeFSP.writeFile(
  NodePath.join(ops, "promotion.json"),
  JSON.stringify({ phase: "switching", id, candidate: root, previous: root }),
);
const cli =
  process.env.HARNESS_RECOVERY_CONTROLLER ?? NodePath.join(root, "scripts/harness-runtime.ts");
let unit = "mt-harness-runtime-proof";
let attempt = 0;
let mainPid = 0;
async function command(args) {
  return new Promise((resolve, reject) => {
    const c = NodeChildProcess.spawn(args[0], args.slice(1), { stdio: "ignore" });
    c.on("error", reject);
    c.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Command " + args[0] + " " + args[1] + " exited " + code)),
    );
  });
}
async function waitUntil(directory, read) {
  const abort = new AbortController();
  const watch = NodeFSP.watch(directory, { signal: abort.signal });
  const timeout = setTimeout(() => abort.abort(), 30000);
  try {
    let v = await read();
    if (v) return v;
    for await (const _event of watch) {
      v = await read();
      if (v) return v;
    }
    throw Error("Proof milestone timeout");
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}
async function start() {
  unit = "mt-harness-runtime-proof-" + process.pid + "-" + attempt++;
  await command([
    "systemd-run",
    "--user",
    "--unit=" + unit,
    "--property=Type=exec",
    "--property=Restart=no",
    "--property=StandardOutput=null",
    "--property=StandardError=null",
    "--setenv=HARNESS_OPERATIONS=" + ops,
    node,
    cli,
    "host",
  ]);
  mainPid = Number(
    NodeChildProcess.spawnSync(
      "systemctl",
      ["--user", "show", unit, "--property=MainPID", "--value"],
      {
        encoding: "utf8",
      },
    ).stdout,
  );
}
const database = NodePath.join(home, "userdata/statev2.sqlite");
function read(sql) {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}
let started = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void (started ? command(["systemctl", "--user", "stop", unit]) : Promise.resolve())
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
}
try {
  await start();
  started = true;
  await waitUntil(ops, async () => {
    try {
      const p = JSON.parse(
        await NodeFSP.readFile(NodePath.join(ops, "trial-prepared.json"), "utf8"),
      );
      return p.id === id && p.hostPid === mainPid;
    } catch {
      return false;
    }
  });

  await command(["systemctl", "--user", "kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
  started = false;
  await NodeFSP.writeFile(
    NodePath.join(ops, "promotion.json"),
    JSON.stringify({ phase: "activating", id, candidate: root, previous: root }),
  );
  await start();
  started = true;
  await waitUntil(ops, async () => {
    try {
      const p = JSON.parse(
        await NodeFSP.readFile(NodePath.join(ops, "trial-prepared.json"), "utf8"),
      );
      return p.id === id && p.hostPid === mainPid;
    } catch {
      return false;
    }
  });
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 3600000).toISOString();
  const db = new NodeSqlite.DatabaseSync(database);
  const insert = db.prepare(
    `INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,next_run_at,last_run_status,run_count) VALUES (?,?,?,?,?,? ,NULL,?,?,?,?,?,?,?,?,?,'never',0)`,
  );
  for (const [task, enabled, schedule] of [
    ["interval", 1, { type: "interval", everyMs: 60000 }],
    ["missed-fixed", 1, { type: "fixed_time", timeOfDay: "04:00" }],
    ["disabled", 0, { type: "interval", everyMs: 60000 }],
  ])
    insert.run(
      task,
      task,
      "No real action: invalid fixture project",
      enabled,
      JSON.stringify(schedule),
      "nonexistent-runtime-proof-project",
      JSON.stringify({ type: "root" }),
      JSON.stringify({ instanceId: "codex", model: "gpt-6.1-sol" }),
      "full-access",
      "default",
      "user",
      "web",
      now,
      now,
      past,
    );
  db.close();
  // Confirm parked scheduler has not dispatched even though a durable overdue task exists.
  if (read("SELECT run_count FROM scheduled_tasks WHERE task_id='interval'")[0].run_count !== 0)
    throw Error("Scheduler crossed trial gate");
  await NodeFSP.writeFile(
    NodePath.join(ops, "promotion.json"),
    JSON.stringify({ phase: "activating", id, candidate: root, previous: root }),
  );
  await NodeFSP.writeFile(NodePath.join(ops, "trial-commit.json"), JSON.stringify({ id }));
  const descriptor = await (
    await fetch("http://127.0.0.1:" + port + "/.well-known/t3/environment", {
      signal: AbortSignal.timeout(10000),
    })
  ).json();
  config.environmentId = descriptor.environmentId;
  await NodeFSP.writeFile(NodePath.join(ops, "config.json"), JSON.stringify(config));
  const { awaitReady } = await import(
    NodePath.join(NodePath.dirname(cli), "lib/runtime-maintenance/ready.ts")
  );
  await awaitReady(config, id);
  const { stateDigest } = await import(
    NodePath.join(NodePath.dirname(cli), "lib/runtime-maintenance/state.ts")
  );
  await stateDigest(home);
  await NodeFSP.writeFile(
    NodePath.join(ops, "promotion.json"),
    JSON.stringify({ phase: "committed", id, candidate: root, previous: root }),
  );
  const unauthorized = await fetch("http://127.0.0.1:" + port + "/api/orchestration/shell", {
    signal: AbortSignal.timeout(10000),
  });
  if (unauthorized.status !== 401) throw Error("Auth absent");
  await waitUntil(
    NodePath.join(home, "userdata"),
    async () =>
      read("SELECT run_count FROM scheduled_tasks WHERE task_id='interval'")[0].run_count === 1,
  );
  const first = read(
    "SELECT task_id,run_count,last_run_status,last_run_at,next_run_at FROM scheduled_tasks ORDER BY task_id",
  );
  if (
    first.find((x) => x.task_id === "disabled").run_count !== 0 ||
    first.find((x) => x.task_id === "missed-fixed").run_count !== 0
  )
    throw Error("Skipped/disabled task ran");
  await command(["systemctl", "--user", "stop", unit]);
  started = false;
  const crash = new NodeSqlite.DatabaseSync(database);
  crash.exec(
    "UPDATE scheduled_tasks SET last_run_status='running',next_run_at='2026-01-01T00:00:00.000Z' WHERE task_id='interval'",
  );
  crash.close();
  await start();
  started = true;
  await waitUntil(
    NodePath.join(home, "userdata"),
    async () =>
      read("SELECT run_count FROM scheduled_tasks WHERE task_id='interval'")[0].run_count === 2,
  );
  const recovered = read(
    "SELECT task_id,run_count,last_run_status,last_run_at,next_run_at FROM scheduled_tasks ORDER BY task_id",
  );
  if (
    recovered.find((x) => x.task_id === "interval").last_run_at !==
    first.find((x) => x.task_id === "interval").last_run_at
  )
    throw Error("Interrupted attempt was redispatched");
  if (recovered.find((x) => x.task_id === "interval").last_run_status !== "failed")
    throw Error("Crash attempt not recovered");
  await NodeFSP.mkdir(NodePath.join(root, ".logs/harness/runtime"), {
    recursive: true,
    mode: 0o700,
  });
  await NodeFSP.writeFile(
    NodePath.join(root, ".logs/harness/runtime/service-proof.json"),
    JSON.stringify(
      {
        port,
        home,
        trialPrepared: true,
        switchingCrashGate: true,
        activatingRestartGate: true,
        matchingLifecycleReady: true,
        authRequired: true,
        clientOpened: false,
        trialSchedulerParked: true,
        overdueIntervalSingleAttempt: true,
        missedFixedSkipped: true,
        disabledPreserved: true,
        crashAttemptRecovered: true,
        interruptedAttemptNotRedispatched: true,
        externalEffectsExactlyOnceProven: false,
        first,
        recovered,
      },
      null,
      2,
    ),
  );
  console.log("Dedicated systemd host proof passed");
} finally {
  if (started) await command(["systemctl", "--user", "stop", unit]);
  await command(["systemctl", "--user", "reset-failed", unit]).catch(() => {});
}

const faultOps = await NodeFSP.mkdtemp(NodePath.join(root, ".t3/runtime-fault-"));
const faultHome = NodePath.join(faultOps, "home");
const faultId = NodeCrypto.randomUUID();
const faultConfig = { ...config, operations: faultOps, home: faultHome, environmentId: "fault" };
await NodeFSP.writeFile(NodePath.join(faultOps, "config.json"), JSON.stringify(faultConfig));
await NodeFSP.symlink(root, NodePath.join(faultOps, "current"));
await NodeFSP.writeFile(
  NodePath.join(faultOps, "promotion.json"),
  JSON.stringify({ phase: "activating", id: faultId, candidate: root, previous: root }),
);
const preload = NodePath.join(faultOps, "kill-after-commit.mjs");
await NodeFSP.writeFile(
  preload,
  `if(process.env.T3_SERVICE_LAUNCHER_CONTEXT) process.prependListener('message', m=>{if(m?.type==='committed') process.kill(process.pid,'SIGKILL')});`,
);
unit = "mt-harness-runtime-fault-" + process.pid;
await command([
  "systemd-run",
  "--user",
  "--unit=" + unit,
  "--property=Type=exec",
  "--property=Restart=no",
  "--property=StandardOutput=null",
  "--property=StandardError=null",
  "--setenv=HARNESS_OPERATIONS=" + faultOps,
  "--setenv=NODE_OPTIONS=--import " + preload,
  node,
  cli,
  "host",
]);
started = true;
try {
  await waitUntil(faultOps, async () => {
    try {
      return (
        JSON.parse(await NodeFSP.readFile(NodePath.join(faultOps, "trial-prepared.json"), "utf8"))
          .id === faultId
      );
    } catch {
      return false;
    }
  });
  await NodeFSP.writeFile(
    NodePath.join(faultOps, "trial-commit.json"),
    JSON.stringify({ id: faultId }),
  );
  let rejected = false;
  try {
    const { awaitReady } = await import(
      NodePath.join(NodePath.dirname(cli), "lib/runtime-maintenance/ready.ts")
    );
    await awaitReady(faultConfig, faultId);
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error("Killed trial was falsely ready");
  const pending = JSON.parse(
    await NodeFSP.readFile(NodePath.join(faultOps, "promotion.json"), "utf8"),
  );
  if (pending.phase !== "activating") throw Error("Killed trial falsely committed");
  await NodeFSP.writeFile(
    NodePath.join(root, ".logs/harness/runtime/fault-proof.json"),
    JSON.stringify(
      {
        killedAfterNativeCommittedBeforeReady: true,
        readyRejected: true,
        journalNotCommitted: true,
        home: faultHome,
      },
      null,
      2,
    ),
  );
  console.log("Native post-commit crash was refused");
} finally {
  if (started) await command(["systemctl", "--user", "stop", unit]).catch(() => {});
  await command(["systemctl", "--user", "reset-failed", unit]).catch(() => {});
}
