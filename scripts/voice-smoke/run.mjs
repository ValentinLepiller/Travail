import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDgram from "node:dgram";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { assessResult, findResultTurn } from "./result.mjs";
import { assessConversation } from "./conversation.mjs";

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
if (!["all", "immediate", "late", "conversation"].includes(values.scenario)) {
  throw new Error("--scenario must be all, immediate, late, or conversation");
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
  const conversational = scenario === "conversation";
  const { RTCPeerConnection, MediaStreamTrack, RtpPacket, CodexVoiceSession } = dependencies;
  const marker = `${["violet", "amber", "cobalt", "indigo"][NodeCrypto.randomInt(4)]} ${["seventeen", "twenty seven", "thirty nine", "forty two"][NodeCrypto.randomInt(4)]}`;
  const now = () => Math.round(performance.now() - began);
  const began = performance.now();
  const deadline = began + (conversational ? 90000 : 70000);
  const turns = new Map();
  const packets = [];
  const eventTypes = {};
  const callbacks = [];
  const timeline = [];
  const trace = (event, fields = {}) => {
    if (timeline.length < 100) timeline.push({ atMs: now(), event, ...fields });
  };
  const safeText = (value) =>
    String(value ?? "")
      .replace(/Bearer\s+\S+|sk-[\w-]+|[\w.+-]+@[\w.-]+/gi, "[redacted]")
      .slice(0, 400);
  let resolvedAtMs;
  let firstDelegationAtMs;
  let inputStartedAtMs;
  let secondInputStartedAtMs;
  let secondInputEndAtMs;
  let releaseAnswer;
  let rejectAnswer;
  const heldAnswer = conversational
    ? new Promise((resolve, reject) => {
        releaseAnswer = resolve;
        rejectAnswer = reject;
      })
    : undefined;
  const conversation = { ack: undefined, exchange: undefined, prematureMarker: false };
  const voiceModel = { id: null, source: "not_exposed_by_native_session" };
  let inputSequence = 0;
  let inputTimestamp = 0;
  let checkingConversation = false;
  let lastCheckPackets = 0;
  let protocolError = false;
  let packetLimitReached = false;
  let encoderError = false;
  let decoderError = false;
  let failureCode;
  let connected = false;
  let channelOpened = false;
  let encoder;
  const stoppedEncoders = new WeakSet();
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
      const packet = RtpPacket.deSerialize(buffer);
      if (conversational) {
        packet.header.sequenceNumber = inputSequence++ % 65536;
        packet.header.timestamp = inputTimestamp;
        inputTimestamp = (inputTimestamp + 960) >>> 0;
      }
      track.writeRtp(packet);
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
      if (type === "error") {
        protocolError = true;
        trace("provider_error", {
          code: safeText(item.error?.code),
          message: safeText(item.error?.message),
        });
      }
      if (type === "delegation.created" || type === "delegation.context.appended") trace(type);
      if (type === "delegation.created") firstDelegationAtMs ??= now();
      if (typeof item.session?.model === "string") {
        voiceModel.id = item.session.model;
        voiceModel.source = type;
      }
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
      if (conversational && resolvedAtMs === undefined) {
        for (const turn of turns.values())
          if (turn.role === "assistant" && turn.text.toLowerCase().includes(marker))
            conversation.prematureMarker = true;
      }
      checkConversation();
      changed();
    } catch {
      protocolError = true;
      changed();
    }
  });
  pc.onTrack.subscribe((received) => {
    if (received.kind !== "audio") return;
    received.onReceiveRtp.subscribe((packet) => {
      if (packets.length >= (conversational ? 6000 : 4000)) {
        if (!packetLimitReached) trace("probe_packet_limit");
        packetLimitReached = true;
        changed();
        return;
      }
      packets.push({
        timestamp: packet.header.timestamp,
        payload: packet.payload.toString("base64"),
        receivedAtMs: now(),
      });
      checkConversation();
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
      trace("callback_started", { count: callbacks.length });
      if (conversational) {
        signal.addEventListener(
          "abort",
          () => rejectAnswer(new Error("Synthetic work cancelled")),
          { once: true },
        );
        await heldAnswer;
      }
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
      trace("callback_resolved");
      changed();
      return `The synthetic confirmation code is ${marker}. No task was executed.`;
    },
  });
  // Observe the real adapter without changing its protocol, flags, or arguments.
  const nativeLines = NodeReadline.createInterface({ input: session.child.stdout });
  nativeLines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (["turn/started", "turn/completed"].includes(message.method)) trace(message.method);
      if (message.method === "thread/realtime/itemAdded") {
        const item = message.params?.item;
        if (item?.type === "handoff_request") trace("native_handoff");
      }
      if (message.method === "thread/realtime/error") {
        trace("native_provider_error", { message: safeText(message.params?.message) });
      }
    } catch {
      /* The adapter owns protocol decoding. */
    }
  });
  const originalDeliver = session.deliver.bind(session);
  session.deliver = (text, prompt, revision) => {
    trace("deliver_attempt", {
      revision,
      currentRevision: session.revision,
      closed: session.closed,
      threadPresent: !!session.threadId,
      markerPresent: text.toLowerCase().includes(marker),
    });
    return originalDeliver(text, prompt, revision);
  };
  const originalRequest = session.request.bind(session);
  session.request = async (method, params) => {
    if (method !== "thread/realtime/appendSpeech") return originalRequest(method, params);
    trace("appendSpeech_requested", { markerPresent: params.text.toLowerCase().includes(marker) });
    try {
      const result = await originalRequest(method, params);
      trace("appendSpeech_accepted");
      return result;
    } catch (error) {
      trace("appendSpeech_error", { message: safeText(error.message) });
      throw error;
    }
  };
  function startEncoder(file) {
    if (encoder) {
      stoppedEncoders.add(encoder);
      encoder.kill();
    }
    encoder = NodeChildProcess.spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-i",
        file,
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
    const child = encoder;
    encoder.on("error", () => {
      encoderError = true;
      changed();
    });
    encoder.on("exit", (code, signal) => {
      if (!stoppedEncoders.has(child) && code && !signal) {
        encoderError = true;
        changed();
      }
    });
  }
  function checkConversation() {
    if (
      !conversational ||
      checkingConversation ||
      firstDelegationAtMs === undefined ||
      resolvedAtMs !== undefined ||
      !callbacks.length
    )
      return;
    const startAtMs = conversation.ack ? secondInputEndAtMs : firstDelegationAtMs;
    if (startAtMs === undefined || now() < startAtMs) return;
    const turn = [...turns.entries()].find(
      ([id, t]) =>
        t.role === "assistant" &&
        t.text.trim() &&
        t.startedAtMs >= (conversation.ack ? secondInputStartedAtMs : firstDelegationAtMs) &&
        id !== conversation.ack?.turnId,
    );
    if (!turn) return;
    const audioStartAtMs = Math.max(startAtMs, turn[1].startedAtMs);
    const eligible = packets.filter(
      (p) => p.receivedAtMs >= audioStartAtMs && Buffer.from(p.payload, "base64").length > 3,
    );
    if (eligible.length < 10 || eligible.length < lastCheckPackets + 10) return;
    lastCheckPackets = eligible.length;
    checkingConversation = true;
    void (async () => {
      const label = conversation.ack ? "exchange" : "ack";
      const packetFile = NodePath.join(scratch, `${label}-packets.json`);
      await NodeFSP.writeFile(packetFile, JSON.stringify(packets));
      const decoded = python([
        "decode",
        packetFile,
        NodePath.join(output, `${scenario}-${label}.wav`),
        String(audioStartAtMs),
        String(now()),
      ]);
      const pcm = decoded.status === 0 ? JSON.parse(decoded.stdout) : undefined;
      if (!pcm || pcm.windowPeak <= 32 || pcm.windowRms <= 2 || pcm.windowNonDtxPackets < 5) return;
      const record = {
        turnId: turn[0],
        verifiedAtMs: now(),
        backendPendingAtVerification: resolvedAtMs === undefined,
        textSha256: hash(turn[1].text),
        pcm,
      };
      if (!conversation.ack) {
        conversation.ack = record;
        trace("ack_audio_verified");
        secondInputStartedAtMs = now();
        secondInputEndAtMs = secondInputStartedAtMs + dependencies.statusDurationMs;
        lastCheckPackets = 0;
        trace("second_input_started");
        startEncoder(NodePath.join(scratch, "status-input.wav"));
      } else {
        const transcribed = [...turns.values()].some(
          (t) =>
            t.role === "user" &&
            t.startedAtMs >= secondInputStartedAtMs &&
            /still (there|working)/i.test(t.text),
        );
        if (!transcribed) return;
        conversation.exchange = { ...record, transcribed };
        trace("second_response_audio_verified");
        releaseAnswer();
      }
    })()
      .catch(() => {
        decoderError = true;
        trace("probe_decoder_error");
      })
      .finally(() => {
        checkingConversation = false;
        changed();
      });
  }
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
      inputStartedAtMs = now();
      startEncoder(NodePath.join(scratch, "input.wav"));
      await waitFor(() => {
        matchedTurn = findResultTurn([...turns.values()], marker, resolvedAtMs);
        return !!matchedTurn || protocolError || encoderError || decoderError || packetLimitReached;
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
    if (encoder) {
      stoppedEncoders.add(encoder);
      encoder.kill();
    }
    udp.close();
    session.close();
    nativeLines.close();
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
  if (decoderError) {
    assessment.passed = false;
    assessment.failures.push("probe_decoder_failed");
  }
  if (abort.signal.aborted) {
    assessment.passed = false;
    assessment.failures.push("smoke_interrupted");
  }
  if (packetLimitReached) {
    assessment.passed = false;
    assessment.failures.push("probe_packet_limit_reached");
  }
  if (failureCode) {
    assessment.passed = false;
    assessment.failures.push(failureCode);
  }
  if (conversational) {
    const extra = assessConversation({
      callbackCount: callbacks.length,
      resolvedAtMs,
      ...conversation,
    });
    assessment.failures.push(...extra.failures);
    assessment.passed &&= extra.passed;
  }
  return {
    scenario,
    ...assessment,
    marker,
    phase,
    callbacks,
    resolvedAtMs,
    eventTypes,
    timeline,
    notices: session.takeNotices().slice(-20).map(safeText),
    pcm,
    voiceModel,
    ...(conversational
      ? {
          conversation,
          timing: {
            origin: "scenario_start_monotonic",
            inputStartedAtMs,
            firstDelegationAtMs,
            callbackStartedAtMs: callbacks[0]?.startedAtMs,
            secondInputStartedAtMs,
            secondInputEndAtMs,
            backendResolvedAtMs: resolvedAtMs,
            handoffToFirstAckPcmMs: conversation.ack
              ? conversation.ack.pcm.firstAudibleReceivedAtMs - firstDelegationAtMs
              : null,
            callbackToFirstAckPcmMs: conversation.ack
              ? conversation.ack.pcm.firstAudibleReceivedAtMs - callbacks[0].startedAtMs
              : null,
            handoffToAckVerifiedMs: conversation.ack
              ? conversation.ack.verifiedAtMs - firstDelegationAtMs
              : null,
            callbackToAckVerifiedMs: conversation.ack
              ? conversation.ack.verifiedAtMs - callbacks[0].startedAtMs
              : null,
          },
        }
      : {}),
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
    interrupted: abort.signal.aborted,
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
  await NodeFSP.mkdir(NodePath.join(scratch, "codex"), { mode: 0o700 });
  await NodeFSP.copyFile(
    NodePath.join(environment.CODEX_HOME, "auth.json"),
    NodePath.join(scratch, "codex/auth.json"),
  );
  await NodeFSP.chmod(NodePath.join(scratch, "codex/auth.json"), 0o600);
  environment.CODEX_HOME = NodePath.join(scratch, "codex");
  summary.privateNativeHome = true;
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
  let statusDurationMs;
  if (values.scenario === "conversation" || values.scenario === "all") {
    const status = python([
      "prepare",
      NodePath.join(folder, "status.wav"),
      NodePath.join(scratch, "status-input.wav"),
    ]);
    if (status.status !== 0) throw new Error("status_fixture_unavailable");
    statusDurationMs = JSON.parse(status.stdout).sourceDurationMs;
  }
  for (const scenario of values.scenario === "all"
    ? ["immediate", "late", "conversation"]
    : [values.scenario]) {
    summary.scenarios.push(
      await smoke(scenario, { ...rtc, CodexVoiceSession, statusDurationMs }, scratch, output),
    );
    if (abort.signal.aborted) break;
  }
  summary.passed =
    summary.scenarios.length === (values.scenario === "all" ? 3 : 1) &&
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
