import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { prepareHarnessHome } from "../lib/harness-home.ts";
import {
  codexAppServerArgs,
  resolveCodexLaunchArgs,
} from "../../apps/server/src/provider/codexLaunchArgs.ts";
import {
  codexAppServerEnvironment,
  buildCodexInitializeParams,
} from "../../apps/server/src/provider/CodexProvider.ts";
import { resolveSpawnCommand } from "../../packages/shared/src/shell.ts";
import { assessProof, observeItem, providerFailure } from "./proof.mjs";

const root = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const loadSdkDependency = NodeModule.createRequire(
  new URL("../../packages/effect-codex-app-server/package.json", import.meta.url),
);
const modules = await Promise.all(
  [
    "effect/Effect",
    "effect/Deferred",
    "effect/process/ChildProcess",
    "effect/process/ChildProcessSpawner",
    "@effect/platform-node/NodeServices",
  ].map((name) => import(NodeURL.pathToFileURL(loadSdkDependency.resolve(name)).href)),
);
const [Effect, Deferred, ChildProcess, ChildProcessSpawner, NodeServices] = modules;
const CodexClient = await import("../../packages/effect-codex-app-server/src/client.ts");
const { values } = NodeUtil.parseArgs({
  options: {
    codex: { type: "string" },
    home: { type: "string" },
    settings: {
      type: "string",
      default: NodePath.join(root, ".t3/harness/userdata/settings.json"),
    },
    out: { type: "string", default: NodePath.join(root, ".logs/harness/agent-smoke") },
    "timeout-ms": { type: "string", default: "180000" },
  },
});
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(timeoutMs) || timeoutMs < 120000 || timeoutMs > 180000)
  throw new Error("Use a 120000–180000ms deadline");
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-agent-smoke-"));
const workspace = NodePath.join(scratch, "workspace");
const taskCodexHome = NodePath.join(scratch, "codex");
const runId = NodeCrypto.randomUUID();
const outputRoot = NodePath.resolve(values.out);
const output = NodePath.join(outputRoot, "runs", runId);
const markers = {
  parent: `parent-${NodeCrypto.randomUUID()}`,
  child: `child-${NodeCrypto.randomUUID()}`,
};
const proof = {
  parentId: undefined,
  parentCompleted: false,
  parentMarker: false,
  parentReturnedChildMarker: false,
  children: new Set(),
  completedChildren: new Set(),
  childMarkerObserved: new Set(),
  verifiedChildHistories: new Set(),
  disallowedActions: new Set(),
};
const receipt = {
  runId,
  testedAt: new Date().toISOString(),
  passed: false,
  task: "synthetic-parent-and-child",
  paidApiFallback: false,
  externalBusinessTask: false,
  nativeSpawnEvents: 0,
  nativeWaitEvents: 0,
};
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
let exitCode = 2;
let phase = "preparation";
try {
  await NodeFSP.mkdir(workspace, { mode: 0o700 });
  await NodeFSP.mkdir(taskCodexHome, { mode: 0o700 });
  let settingsRaw;
  try {
    settingsRaw = await NodeFSP.readFile(values.settings, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await prepareHarnessHome(NodePath.join(scratch, "harness"));
    settingsRaw = await NodeFSP.readFile(
      NodePath.join(scratch, "harness/userdata/settings.json"),
      "utf8",
    );
  }
  const configured = JSON.parse(settingsRaw).providerInstances?.codex;
  if (configured?.driver !== "codex" || configured.config?.setupMode !== "existing")
    throw new Error("native_profile_required");
  receipt.profileSha256 = hash(settingsRaw);
  const profile = configured.config;
  const sourceHome =
    (values.home ?? profile.homePath?.trim()) || NodePath.join(root, ".t3/harness/codex");
  const expandedHome = sourceHome.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), sourceHome.slice(2))
    : sourceHome;
  receipt.authSourceHome = NodePath.resolve(expandedHome);
  // Private transient credential snapshot; native refreshes cannot modify the original home.
  await NodeFSP.copyFile(
    NodePath.join(expandedHome, "auth.json"),
    NodePath.join(taskCodexHome, "auth.json"),
  );
  await NodeFSP.chmod(NodePath.join(taskCodexHome, "auth.json"), 0o600);
  const env = {
    ...process.env,
    CODEX_HOME: taskCodexHome,
    XDG_CONFIG_HOME: NodePath.join(scratch, "config"),
    XDG_CACHE_HOME: NodePath.join(scratch, "cache"),
    XDG_DATA_HOME: NodePath.join(scratch, "data"),
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.ACCESS_TOKEN;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete env[key];
  }
  Object.assign(env, codexAppServerEnvironment(env));
  const launchArgs = resolveCodexLaunchArgs(profile.launchArgs, env);
  receipt.launchArgsSha256 = hash(launchArgs);
  const program = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = yield* resolveSpawnCommand(
      values.codex ?? profile.binaryPath,
      codexAppServerArgs(launchArgs),
      { env, extendEnv: false },
    );
    const versionCommand = yield* resolveSpawnCommand(
      values.codex ?? profile.binaryPath,
      ["--version"],
      { env, extendEnv: false },
    );
    const version = NodeChildProcess.spawnSync(versionCommand.command, versionCommand.args, {
      env,
      shell: versionCommand.shell,
      encoding: "utf8",
      timeout: 10000,
    });
    if (version.status !== 0 || !/^codex-cli [0-9A-Za-z.-]+\s*$/.test(version.stdout))
      return yield* Effect.fail(new Error("Candidate version unavailable"));
    receipt.nativeVersion = version.stdout.trim();
    const handle = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        cwd: workspace,
        env,
        extendEnv: false,
        shell: command.shell,
        forceKillAfter: "2 seconds",
      }),
    );
    yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      const finished = yield* Deferred.make();
      yield* client.handleUnknownServerRequest(() =>
        Effect.fail(new Error("No external tool or approval is allowed in this synthetic probe")),
      );
      yield* client.handleServerNotification("item/completed", (payload) =>
        Effect.sync(() => {
          observeItem(proof, payload.threadId, payload.item, markers);
          if (payload.threadId === proof.parentId && payload.item.type === "subAgentActivity") {
            if (payload.item.kind === "started") receipt.nativeSpawnEvents++;
          }
          if (payload.item.type === "collabAgentToolCall" && payload.item.status === "completed") {
            if (payload.item.tool === "spawnAgent") receipt.nativeSpawnEvents++;
            if (payload.item.tool === "wait") receipt.nativeWaitEvents++;
          }
        }),
      );
      yield* client.handleServerNotification("turn/completed", (payload) =>
        Effect.gen(function* () {
          if (payload.threadId === proof.parentId) {
            proof.parentCompleted = payload.turn.status === "completed";
            receipt.parentTurnStatus = payload.turn.status;
            if (payload.turn.error) receipt.providerFailure = providerFailure(payload.turn.error);
            yield* Deferred.succeed(finished, undefined);
          }
        }),
      );
      phase = "authentication";
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);
      const account = yield* client.request("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt")
        return yield* Effect.fail(new Error("native_chatgpt_login_required"));
      receipt.auth = "chatgpt";
      const effective = yield* client.request("config/read", { includeLayers: false });
      receipt.effective = {
        model: effective.config.model,
        multiAgent: effective.config.features?.multi_agent,
        multiAgentV2: effective.config.features?.multi_agent_v2,
        codeMode: effective.config.features?.code_mode,
      };
      phase = "synthetic_turn";
      const started = yield* client.request("thread/start", {
        cwd: workspace,
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: {
          "features.apps": false,
          "features.plugins": false,
          web_search: "disabled",
          mcp_servers: {},
        },
        baseInstructions:
          "This is a synthetic native multi-agent health check. Use only native agent spawning and waiting. Do not run commands, read or write files, use web or apps, or access any other task. Spawn exactly one child; it must not spawn children. Wait until it actually finishes before answering. Do not fabricate a child result.",
      });
      proof.parentId = started.thread.id;
      receipt.model = started.model;
      receipt.modelProvider = started.modelProvider;
      receipt.reasoningEffort = started.reasoningEffort;
      yield* client.request("turn/start", {
        threadId: proof.parentId,
        input: [
          {
            type: "text",
            text: `Spawn exactly one real native subagent. Tell it to reply with exactly ${markers.child}, perform no task or tool action, and spawn no other agent. Wait for its completed result. Then reply with ${markers.parent} followed by the child's actual result. Use the inherited model and do not override it.`,
          },
        ],
      });
      yield* Deferred.await(finished);
      const history = yield* client.request("thread/read", {
        threadId: proof.parentId,
        includeTurns: true,
      });
      receipt.parentHistoryItemTypes = {};
      for (const turn of history.thread?.turns ?? []) {
        for (const item of turn.items ?? []) {
          receipt.parentHistoryItemTypes[item.type] =
            (receipt.parentHistoryItemTypes[item.type] ?? 0) + 1;
          observeItem(proof, proof.parentId, item, markers);
        }
      }
      receipt.childHistoryCompleted = false;
      for (const childId of proof.children) {
        const child = yield* client.request("thread/read", {
          threadId: childId,
          includeTurns: true,
        });
        for (const turn of child.thread.turns ?? []) {
          if (turn.status !== "completed") continue;
          for (const item of turn.items ?? []) {
            if (
              child.thread.id === childId &&
              item.type === "agentMessage" &&
              item.text.includes(markers.child)
            ) {
              proof.childMarkerObserved.add(childId);
              proof.verifiedChildHistories.add(childId);
              receipt.childHistoryCompleted = true;
            }
          }
        }
      }
      phase = "assessing";
    }).pipe(
      Effect.provide(
        CodexClient.layerChildProcess(handle, {
          logIncoming: true,
          logger: (event) =>
            Effect.sync(() => {
              if (event.stage !== "decoded") return;
              if (event.payload?.method && event.payload.id !== undefined) {
                receipt.serverRequests ??= [];
                if (receipt.serverRequests.length < 20)
                  receipt.serverRequests.push({
                    method: event.payload.method,
                    tool: event.payload.params?.tool,
                    keys: Object.keys(event.payload.params ?? {}),
                  });
              }
              if (event.payload?.method !== "item/completed") return;
              const item = event.payload.params?.item;
              if (!item?.type) return;
              receipt.nativeItemTypes ??= {};
              receipt.nativeItemTypes[item.type] = (receipt.nativeItemTypes[item.type] ?? 0) + 1;
              if (item.type !== "collabAgentToolCall") return;
              receipt.nativeItemShapes ??= [];
              if (receipt.nativeItemShapes.length >= 20) return;
              receipt.nativeItemShapes.push({
                type: item.type,
                tool: item.tool,
                status: item.status,
                keys: Object.keys(item),
                senderMatchesParent: item.senderThreadId === proof.parentId,
                receiverCount: item.receiverThreadIds?.length ?? 0,
                states: Object.values(item.agentsStates ?? {}).map((state) => ({
                  status: state.status,
                  childMarkerPresent: state.message?.includes(markers.child) ?? false,
                })),
              });
            }),
        }),
      ),
    );
  });
  phase = "launch";
  const began = performance.now();
  try {
    await Effect.runPromise(
      program.pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.timeout(`${timeoutMs} millis`),
      ),
      { signal: abort.signal },
    );
    receipt.elapsedMs = Math.round(performance.now() - began);
    Object.assign(receipt, assessProof(proof));
    receipt.workspaceUnchanged = (await NodeFSP.readdir(workspace)).length === 0;
    if (!receipt.workspaceUnchanged) {
      receipt.passed = false;
      receipt.failures.push("workspace_changed");
    }
    exitCode = receipt.passed ? 0 : 1;
  } catch {
    receipt.failure = `${phase}_failed_or_timed_out`;
    receipt.elapsedMs = Math.round(performance.now() - began);
    exitCode = 1;
  }
} catch {
  receipt.failure = `${phase}_unavailable`;
} finally {
  receipt.phase = phase;
  receipt.parentThreadId = proof.parentId;
  receipt.childThreadIds = [...proof.children];
  receipt.completedChildThreadIds = [...proof.completedChildren];
  receipt.childCompletionAttestedByNativeEvent = proof.completedChildren.size > 0;
  receipt.childMarkerVerifiedInOwnHistory = proof.verifiedChildHistories.size > 0;
  receipt.verifiedChildHistoryIds = [...proof.verifiedChildHistories];
  receipt.parentMarkerObserved = proof.parentMarker;
  receipt.parentReturnedChildMarker = proof.parentReturnedChildMarker;
  receipt.disallowedActions = [...proof.disallowedActions];
  await NodeFSP.rm(scratch, { recursive: true, force: true });
  receipt.temporaryStateRemoved = true;
  await NodeFSP.mkdir(output, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(output, "summary.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const temporaryReceipt = NodePath.join(outputRoot, `${runId}.tmp`);
  await NodeFSP.writeFile(
    temporaryReceipt,
    `${JSON.stringify({ ...receipt, evidenceDirectory: output }, null, 2)}\n`,
  );
  await NodeFSP.rename(temporaryReceipt, NodePath.join(outputRoot, "summary.json"));
  console.log(
    JSON.stringify({ passed: receipt.passed, summary: NodePath.join(outputRoot, "summary.json") }),
  );
  process.exitCode = exitCode;
}
