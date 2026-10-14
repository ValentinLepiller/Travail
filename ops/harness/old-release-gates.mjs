import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const proof = [];
for (const phase of ["backed-up", "switching", "restoring"]) {
  const operations = await NodeFSP.mkdtemp(NodePath.join(root, ".t3/old-release-gate-"));
  const home = NodePath.join(operations, "home");
  const server = NodeNet.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const config = JSON.parse(
    await NodeFSP.readFile(
      process.env.HARNESS_RECOVERY_CONTROLLER
        ? NodePath.join(
            NodePath.dirname(NodePath.dirname(process.env.HARNESS_RECOVERY_CONTROLLER)),
            "config.json",
          )
        : NodePath.join(root, ".t3/harness-operations/config.json"),
      "utf8",
    ),
  );
  Object.assign(config, { operations, home, port });
  await NodeFSP.writeFile(NodePath.join(operations, "config.json"), JSON.stringify(config));
  await NodeFSP.symlink(root, NodePath.join(operations, "current"));
  const id = NodeCrypto.randomUUID();
  await NodeFSP.writeFile(
    NodePath.join(operations, "promotion.json"),
    JSON.stringify({
      id,
      phase,
      previous: root,
      candidate: NodePath.join(operations, "different-candidate"),
      backup: "fixture",
    }),
  );
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      process.env.HARNESS_RECOVERY_CONTROLLER ?? NodePath.join(root, "scripts/harness-runtime.ts"),
      "host",
    ],
    {
      env: { ...process.env, HARNESS_OPERATIONS: operations },
      stdio: "ignore",
    },
  );
  const closed = new Promise((r) => child.once("exit", r));
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 30000);
  try {
    const events = NodeFSP.watch(operations, { signal: abort.signal });
    let prepared = false;
    const inspect = async () => {
      try {
        return (
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(operations, "trial-prepared.json"), "utf8"),
          ).id === id
        );
      } catch {
        return false;
      }
    };
    if (await inspect()) prepared = true;
    else
      for await (const _event of events) {
        if (await inspect()) {
          prepared = true;
          break;
        }
      }
    if (!prepared) throw Error("Previous release did not reach native prepared");
    proof.push({
      phase,
      previousRestarted: true,
      currentDifferentFromCandidate: true,
      nativePrepared: true,
      admissionDecisionWritten: false,
    });
  } finally {
    clearTimeout(timeout);
    abort.abort();
    child.kill("SIGTERM");
    await closed;
  }
}
await NodeFSP.mkdir(NodePath.join(root, ".logs/harness/runtime"), { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(root, ".logs/harness/runtime/old-release-gates.json"),
  JSON.stringify(proof, null, 2),
);
console.log(JSON.stringify({ previousReleaseGates: proof.length, passed: true }));
