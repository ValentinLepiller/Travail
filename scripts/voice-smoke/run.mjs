import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { assessResult, findResultTurn } from "./result.mjs";

const folder = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const root = NodePath.resolve(folder, "../..");
const require = NodeModule.createRequire(import.meta.url);
const hash = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const { values } = NodeUtil.parseArgs({
  options: {
    scenario: { type: "string", default: "all" },
    out: { type: "string", default: NodePath.join(root, ".logs/harness/voice-smoke") },
    codex: { type: "string", default: "codex" },
    home: { type: "string", default: NodePath.join(root, ".t3/harness/codex") },
    python: { type: "string", default: "python3" },
    "werift-path": { type: "string" },
  },
});
if (!["all", "immediate", "late"].includes(values.scenario)) {
  throw new Error("--scenario must be all, immediate, or late");
}
const environment = { ...process.env };
environment.CODEX_HOME = NodePath.resolve(values.home);
delete environment.OPENAI_API_KEY;
delete environment.CODEX_API_KEY;
for (const key of Object.keys(environment)) {
  if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete environment[key];
}
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

const python = (args) =>
  NodeChildProcess.spawnSync(values.python, [NodePath.join(folder, "audio.py"), ...args], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 100000,
    env: environment,
  });

async function smoke(scenario, dependencies, scratch, output) {
  const { RTCPeerConnection, MediaStreamTrack, RtpPacket, CodexVoiceSession } = dependencies;
  const marker = `${["violet", "amber", "cobalt", "indigo"][NodeCrypto.randomInt(4)]} ${["seventeen", "twenty seven", "thirty nine", "forty two"][NodeCrypto.randomInt(4)]}`;
  const now = () => Math.round(performance.now() - began);
  const began = performance.now();
  const deadline = began + 70000;
  const turns = new Map();
  const packets = [];
  const eventTypes = {};
  const callbacks = [];
  let resolvedAtMs;
  let protocolError = false;
  let encoderError = false;
  let failureCode;
  let connected = false;
  let channelOpened = false;
  let encoder;
  let pulse;
  const changed = () => pulse?.();
  const waitFor = async (predicate) => {
    while (!predicate()) {
      if (abort.signal.aborted || performance.now() >= deadline) return false;
      await new Promise((done) => {
        const finish = () => {
          clearTimeout(timer);
          pulse = undefined;
          abort.signal.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, Math.max(1, deadline - performance.now()));
        pulse = finish;
        abort.signal.addEventListener("abort", finish, { once: true });
      });
    }
    return true;
  };
  const pc = new RTCPeerConnection({ iceServers: [] });
  const track = new MediaStreamTrack({ kind: "audio" });
  pc.addTransceiver(track, { direction: "sendrecv" });
  const channel = pc.createDataChannel("oai-events");
  const udp = NodeDgram.createSocket("udp4");
  await new Promise((done, reject) => {
    udp.once("error", reject);
    udp.bind(0, "127.0.0.1", done);
  });
  udp.on("message", (buffer) => {
    try {
      track.writeRtp(RtpPacket.deSerialize(buffer));
    } catch {
      encoderError = true;
      changed();
    }
  });
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") connected = true;
    changed();
  });
  channel.addEventListener("open", () => {
    channelOpened = true;
    changed();
  });
  channel.addEventListener("message", (event) => {
    try {
      const item = JSON.parse(String(event.data));
      const type = /^[a-z_.]+$/.test(item.type ?? "") ? item.type : "unknown";
      eventTypes[type] = (eventTypes[type] ?? 0) + 1;
      if (type === "error") protocolError = true;
      if (["turn.created", "turn.done"].includes(type) && item.turn) {
        const previous = turns.get(item.turn.id);
        turns.set(item.turn.id, {
          role: item.turn.role,
          text: item.turn.transcript ?? previous?.text ?? "",
          startedAtMs: previous?.startedAtMs ?? now(),
          endedAtMs: now(),
          completed: type === "turn.done",
        });
      } else if (type === "turn.delta" && typeof item.delta === "string") {
        const turn = turns.get(item.turn_id);
        if (turn) turn.text += item.delta;
      }
      changed();
    } catch {
      protocolError = true;
      changed();
    }
  });
  pc.onTrack.subscribe((received) => {
    if (received.kind !== "audio") return;
    received.onReceiveRtp.subscribe((packet) => {
      if (packets.length >= 4000) {
        protocolError = true;
        changed();
        return;
      }
      packets.push({
        timestamp: packet.header.timestamp,
        payload: packet.payload.toString("base64"),
        receivedAtMs: now(),
      });
      changed();
    });
  });
  const session = new CodexVoiceSession({
    command: values.codex,
    args: ["app-server", "--disable", "computer_use", "--disable", "browser_use"],
    cwd: scratch,
    env: environment,
    askAgent: async (_prompt, signal) => {
      callbacks.push({ startedAtMs: now(), delayMs: scenario === "late" ? 12000 : 0 });
      if (scenario === "late")
        await new Promise((done, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error("Synthetic callback cancelled"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            done();
          }, 12000);
          signal.addEventListener("abort", cancel, { once: true });
        });
      resolvedAtMs = now();
      changed();
      return `The synthetic confirmation code is ${marker}. No task was executed.`;
    },
  });
  const lease = setInterval(() => {
    if (session.renew()) {
      protocolError = true;
      changed();
    }
  }, 15000);
  let rejectStopped;
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject;
  });
  const stop = () => {
    session.close();
    encoder?.kill();
    void pc.close();
    changed();
    rejectStopped(new Error("Voice scenario stopped"));
  };
  const timeout = setTimeout(stop, Math.max(1, deadline - performance.now()));
  abort.signal.addEventListener("abort", stop, { once: true });
  let phase = "negotiation";
  let matchedTurn;
  try {
    const offer = await Promise.race([pc.createOffer(), stopped]);
    await Promise.race([pc.setLocalDescription(offer), stopped]);
    const answer = await Promise.race([session.start(pc.localDescription.sdp), stopped]);
    await Promise.race([pc.setRemoteDescription({ type: "answer", sdp: answer }), stopped]);
    phase = "transport";
    await waitFor(
      () => channel.readyState === "open" || ["failed", "closed"].includes(pc.connectionState),
    );
    if (channel.readyState === "open") {
      phase = "speech";
      encoder = NodeChildProcess.spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-i",
          NodePath.join(scratch, "input.wav"),
          "-c:a",
          "libopus",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-payload_type",
          "96",
          "-f",
          "rtp",
          `rtp://127.0.0.1:${udp.address().port}?pkt_size=1200`,
        ],
        { stdio: "ignore", env: environment },
      );
      encoder.on("error", () => {
        encoderError = true;
        changed();
      });
      encoder.on("exit", (code, signal) => {
        if (code && !signal) {
          encoderError = true;
          changed();
        }
      });
      await waitFor(() => {
        matchedTurn = findResultTurn([...turns.values()], marker, resolvedAtMs);
        return !!matchedTurn || protocolError || encoderError;
      });
    }
  } catch (error) {
    phase = `${phase}_failed`;
    failureCode =
      error.message === "Cannot get schema for 'SubjectPublicKeyInfo' target"
        ? "webrtc_certificate_schema_conflict"
        : "voice_session_failed";
  } finally {
    clearTimeout(timeout);
    clearInterval(lease);
    abort.signal.removeEventListener("abort", stop);
    encoder?.kill();
    udp.close();
    session.close();
    await pc.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(scratch, `${scenario}-packets.json`),
    JSON.stringify(packets),
  );
  const decoded = python([
    "decode",
    NodePath.join(scratch, `${scenario}-packets.json`),
    NodePath.join(output, `${scenario}.wav`),
    String(matchedTurn ? Math.max(matchedTurn.startedAtMs, resolvedAtMs) : 0),
    String(matchedTurn?.endedAtMs ?? 0),
  ]);
  const pcm = decoded.status === 0 ? JSON.parse(decoded.stdout) : undefined;
  const assessment = assessResult({
    connected,
    channelOpened,
    callbackCount: callbacks.length,
    matchedTurn,
    pcm,
    protocolError,
    encoderError,
  });
  if (failureCode) {
    assessment.passed = false;
    assessment.failures.push(failureCode);
  }
  return {
    scenario,
    ...assessment,
    marker,
    phase,
    callbacks,
    resolvedAtMs,
    eventTypes,
    pcm,
    completedMarkerResponse: matchedTurn
      ? {
          transcriptSha256: hash(matchedTurn.text),
          markerObserved: true,
          startedAtMs: matchedTurn.startedAtMs,
          endedAtMs: matchedTurn.endedAtMs,
        }
      : null,
    elapsedMs: now(),
    cleanupRequested: true,
  };
}

const outputRoot = NodePath.resolve(values.out);
const runId = NodeCrypto.randomUUID();
const output = NodePath.join(outputRoot, "runs", runId);
await NodeFSP.mkdir(output, { recursive: true });
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-voice-smoke-"));
const summary = {
  runId,
  testedAt: new Date().toISOString(),
  proof: "provider-transcript-and-decoded-PCM",
  microphoneUsed: false,
  taskExecuted: false,
  paidApiFallback: false,
  passed: false,
  scenarios: [],
};
let exitCode = 2;
try {
  const version = NodeChildProcess.spawnSync(values.codex, ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    env: environment,
  });
  if (version.status !== 0 || !/^codex-cli [0-9.]+\s*$/.test(version.stdout))
    throw new Error("codex_unavailable");
  summary.codexVersion = version.stdout.trim();
  summary.authHome = environment.CODEX_HOME;
  summary.sourceSha256 = hash(
    await NodeFSP.readFile(NodePath.join(root, "apps/server/src/voice/CodexVoiceSession.ts")),
  );
  summary.fixtureSha256 = hash(await NodeFSP.readFile(NodePath.join(folder, "request.wav")));
  if (
    python(["prepare", NodePath.join(folder, "request.wav"), NodePath.join(scratch, "input.wav")])
      .status !== 0
  )
    throw new Error("python_or_libopus_unavailable");
  const ffmpeg = NodeChildProcess.spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (ffmpeg.status !== 0 || !ffmpeg.stdout.includes("libopus"))
    throw new Error("ffmpeg_libopus_unavailable");
  let rtc;
  try {
    rtc = require(values["werift-path"] ?? "werift");
  } catch {
    throw new Error("werift_unavailable");
  }
  const { CodexVoiceSession } = await import("../../apps/server/src/voice/CodexVoiceSession.ts");
  for (const scenario of values.scenario === "all" ? ["immediate", "late"] : [values.scenario]) {
    summary.scenarios.push(await smoke(scenario, { ...rtc, CodexVoiceSession }, scratch, output));
    if (abort.signal.aborted) break;
  }
  summary.passed =
    summary.scenarios.length === (values.scenario === "all" ? 2 : 1) &&
    summary.scenarios.every((scenario) => scenario.passed);
  summary.sourceUnchanged =
    summary.sourceSha256 ===
    hash(await NodeFSP.readFile(NodePath.join(root, "apps/server/src/voice/CodexVoiceSession.ts")));
  if (!summary.sourceUnchanged) {
    summary.passed = false;
    summary.failure = "bridge_changed_during_smoke";
  }
  exitCode = summary.passed ? 0 : 1;
} catch (error) {
  summary.unavailable = [
    "codex_unavailable",
    "python_or_libopus_unavailable",
    "ffmpeg_libopus_unavailable",
    "werift_unavailable",
  ].includes(error.message)
    ? error.message
    : "voice_smoke_could_not_start";
} finally {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
  await NodeFSP.writeFile(
    NodePath.join(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const receipt = NodePath.join(outputRoot, `${runId}.tmp`);
  await NodeFSP.writeFile(
    receipt,
    `${JSON.stringify({ ...summary, evidenceDirectory: output }, null, 2)}\n`,
  );
  await NodeFSP.rename(receipt, NodePath.join(outputRoot, "summary.json"));
  console.log(
    JSON.stringify({ passed: summary.passed, summary: NodePath.join(outputRoot, "summary.json") }),
  );
  // Give the bridge's public close() its two-second child termination grace.
  setTimeout(() => process.exit(exitCode), 2500);
}
