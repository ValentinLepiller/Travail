// @effect-diagnostics nodeBuiltinImport:off - tests a real Codex-shaped subprocess on a private loopback socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { afterEach, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { CodexVoiceSession, type CodexVoiceOptions } from "./CodexVoiceSession.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(
  askAgent: CodexVoiceOptions["askAgent"],
  options: {
    readonly mode?: "ok" | "apikey" | "error";
    readonly onClosed?: () => void;
    readonly speakInlineMs?: number;
  } = {},
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-voice-test-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const connected = Promise.withResolvers<NodeNet.Socket>();
  const replies = new Map<string, (value: string) => void>();
  const speech: string[] = [];
  let nextSpeech: ((value: string) => void) | undefined;
  const server = NodeNet.createServer((socket) => {
    const lines = NodeReadline.createInterface({ input: socket });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as {
        readonly id?: string;
        readonly method?: string;
        readonly params?: { readonly text: string };
        readonly result?: { readonly contentItems: ReadonlyArray<{ readonly text: string }> };
      };
      if (message.method === "thread/realtime/appendSpeech" && message.params) {
        speech.push(message.params.text);
        nextSpeech?.(message.params.text);
        nextSpeech = undefined;
      } else if (message.id && message.result) {
        replies.get(message.id)?.(message.result.contentItems[0]?.text ?? "");
        replies.delete(message.id);
      }
    });
    connected.resolve(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test socket did not start.");
  let socket: NodeNet.Socket | undefined;
  cleanups.push(async () => {
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await NodeFSP.writeFile(
    NodePath.join(directory, "app-server"),
    `
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
const control = createConnection({host:'127.0.0.1',port:${address.port}});
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:control}).on('line', line => send(JSON.parse(line)));
createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  control.write(JSON.stringify(message)+'\\n');
  if(message.method==='initialize') send({id:message.id,result:{}});
  if(message.method==='account/read') send({id:message.id,result:{account:{type:${JSON.stringify(options.mode === "apikey" ? "apiKey" : "chatgpt")}}}});
  if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'test-thread'}}});
  if(message.method==='thread/realtime/start') {
    send({id:message.id,result:{}});
    send(${JSON.stringify(options.mode === "error" ? { method: "thread/realtime/error", params: { message: "Voice entitlement unavailable" } } : { method: "thread/realtime/sdp", params: { sdp: "answer-sdp" } })});
  }
  if(message.method==='thread/realtime/appendSpeech') send({id:message.id,result:{}});
  if(message.method==='thread/realtime/stop') process.exit(0);
});
process.stdin.on('end',()=>process.exit(0));
`,
  );
  const session = new CodexVoiceSession({
    command: process.execPath,
    args: ["app-server"],
    cwd: directory,
    askAgent,
    ...(options.onClosed ? { onClosed: options.onClosed } : {}),
    speechDelayMs: 0,
    ...(options.speakInlineMs === undefined ? {} : { speakInlineMs: options.speakInlineMs }),
  });
  cleanups.push(() => session.close());
  socket = await connected.promise;
  const notify = (method: string, params: unknown) =>
    socket!.write(`${JSON.stringify({ method, params })}\n`);
  return {
    session,
    speech,
    notify,
    request: (id: string, prompt: string, turnId?: string) => {
      const reply = new Promise<string>((resolve) => replies.set(id, resolve));
      socket!.write(
        `${JSON.stringify({
          id,
          method: "item/tool/call",
          params: {
            tool: "ask_selected_agent",
            callId: id,
            ...(turnId ? { turnId } : {}),
            arguments: { prompt },
          },
        })}\n`,
      );
      return reply;
    },
    speechStarted: () =>
      new Promise<string>((resolve) => {
        nextSpeech = resolve;
      }),
    handoff: (text: string, historyText = text) =>
      notify("thread/realtime/itemAdded", {
        item: {
          type: "handoff_request",
          input_transcript: text,
          active_transcript: [{ role: "user", text: historyText }],
        },
      }),
    utterance: (itemId: string) =>
      notify("thread/realtime/itemAdded", {
        item: { type: "input_audio_buffer.speech_started", item_id: itemId },
      }),
  };
}

it("waits for SDP and returns the selected agent's actual quick answer to the native tool", async () => {
  const asked: string[] = [];
  const test = await fixture(async (prompt) => {
    asked.push(prompt);
    return "17 times 23 is 391.";
  });
  expect(await test.session.start("offer-sdp")).toBe("answer-sdp");
  expect(await test.request("call-1", "Calculate it", "native-1")).toBe("17 times 23 is 391.");
  expect(asked).toEqual(["Calculate it"]);
  expect(test.session.takeNotices()).toContain("Agent result: 17 times 23 is 391.");
  expect(test.speech).toEqual([]);
});

it("acknowledges a pending task after a short beat, then delivers its exact result separately", async () => {
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  const test = await fixture(() => {
    started.resolve();
    return answer.promise;
  });
  await test.session.start("offer-sdp");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let acknowledged = false;
    const acknowledgement = test.request("pending", "Do the work", "native-1").then((text) => {
      acknowledged = true;
      return text;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(249);
    expect(acknowledged).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await acknowledgement).toContain("agent is working");
    expect(test.speech).toEqual([]);
    expect(test.session.takeNotices().some((notice) => notice.startsWith("Agent result:"))).toBe(
      false,
    );
  } finally {
    vi.useRealTimers();
  }
  const speech = test.speechStarted();
  answer.resolve("The exact selected-agent result.");
  expect(await speech).toBe("The exact selected-agent result.");
  expect(test.speech).toEqual(["The exact selected-agent result."]);
});

it("deduplicates paraphrased native retries using the same spoken source", async () => {
  const asked: string[] = [];
  const test = await fixture(async (prompt) => {
    asked.push(prompt);
    return "Confirmed";
  });
  await test.session.start("offer-sdp");
  test.handoff("Confirm this transport check only.");
  await test.request("call-1", "Confirm the check", "native-1");
  test.handoff("Confirm this transport check only.");
  expect(await test.request("call-2", "The same check should be confirmed", "native-1")).toBe(
    "Confirmed",
  );
  expect(asked).toEqual(["Confirm this transport check only."]);
});

it("does not treat the native provider turn ID as a spoken utterance ID", async () => {
  const identities: string[] = [];
  const test = await fixture(async (_prompt, _signal, requestId) => {
    identities.push(requestId);
    return "Confirmed";
  });
  await test.session.start("offer-sdp");
  test.utterance("spoken-1");
  test.handoff("Repeat the check.");
  await test.request("call-1", "Repeat", "same-native-turn");
  test.utterance("spoken-2");
  test.handoff("Repeat the check.");
  await test.request("call-2", "Repeat", "same-native-turn");
  expect(identities).toHaveLength(2);
  expect(identities[0]).not.toBe(identities[1]);
});

it("accepts changed source instructions within one native provider turn", async () => {
  const asked: string[] = [];
  const test = await fixture(async (prompt) => {
    asked.push(prompt);
    return "Confirmed";
  });
  await test.session.start("offer-sdp");
  test.handoff("First instruction");
  await test.request("call-1", "First", "same-native-turn");
  test.handoff("Updated instruction", "First instruction");
  await test.request("call-2", "Updated", "same-native-turn");
  expect(asked).toEqual(["First instruction", "Updated instruction"]);
});

it("invalidates an old result as soon as source changes before the next tool call", async () => {
  const first = Promise.withResolvers<string>();
  const test = await fixture(() => first.promise);
  await test.session.start("offer-sdp");
  test.handoff("First instruction");
  const reply = test.request("call-1", "First", "same-native-turn");
  test.handoff("Updated instruction", "First instruction");
  // A round trip proves the new source was consumed before resolving the older work.
  await test.request("barrier", "", "same-native-turn");
  first.resolve("Old result");
  expect(await reply).not.toBe("Old result");
  expect(test.speech).toEqual([]);
  expect(test.session.takeNotices()).not.toContain("Agent result: Old result");
});

it("delivers an update during work and ignores the older late answer", async () => {
  const first = Promise.withResolvers<string>();
  const latest = Promise.withResolvers<string>();
  const asked: string[] = [];
  const test = await fixture(
    async (prompt) => {
      asked.push(prompt);
      return prompt === "First" ? first.promise : latest.promise;
    },
    { speakInlineMs: 0 },
  );
  await test.session.start("offer-sdp");
  test.utterance("spoken-1");
  await test.request("call-1", "First", "native-1");
  test.utterance("spoken-2");
  await test.request("call-2", "Updated", "native-1");
  expect(await test.request("call-3", "Paraphrased updated request", "native-1")).toContain(
    "Already asked",
  );
  const spoken = test.speechStarted();
  latest.resolve("Updated result.");
  expect(await spoken).toBe("Updated result.");
  first.resolve("Obsolete result.");
  await first.promise;
  expect(asked).toEqual(["First", "Updated"]);
  expect(test.session.takeNotices()).not.toContain("Agent result: Obsolete result.");
  expect(test.speech).toEqual(["Updated result."]);
});

it("preserves a pending task result across conversational speech without another handoff", async () => {
  const answer = Promise.withResolvers<string>();
  let requests = 0;
  const test = await fixture(
    () => {
      requests++;
      return answer.promise;
    },
    { speakInlineMs: 0 },
  );
  await test.session.start("offer-sdp");
  test.utterance("work");
  test.handoff("Do the work");
  await test.request("call-work", "Do the work", "native-1");
  test.utterance("status-question");
  test.notify("thread/realtime/itemAdded", {
    item: { type: "turn.created", turn: { id: "conversation", role: "user" } },
  });
  // This transport barrier ensures the conversation was observed before work finishes.
  await test.request("barrier", "", "native-1");
  const speech = test.speechStarted();
  answer.resolve("Completed task result.");
  expect(await speech).toBe("Completed task result.");
  expect(requests).toBe(1);
});

it("keeps a work result when a status handoff finishes without asking the agent again", async () => {
  const answer = Promise.withResolvers<string>();
  const test = await fixture(() => answer.promise, { speakInlineMs: 0 });
  await test.session.start("offer-sdp");
  test.handoff("Do the work");
  await test.request("work", "Do the work", "native-1");
  test.utterance("status");
  test.handoff("Are you still working?");
  test.notify("turn/started", { threadId: "test-thread", turn: { id: "status-turn" } });
  test.notify("turn/completed", {
    threadId: "test-thread",
    turn: { id: "status-turn", status: "completed" },
  });
  await test.request("barrier-before-result", "", "native-1");
  const speech = test.speechStarted();
  answer.resolve("The completed work result.");
  expect(await speech).toBe("The completed work result.");
  expect(test.session.takeNotices()).toContain("Agent result: The completed work result.");
});

it("holds an old result until a changed source is classified after a speech boundary", async () => {
  const answer = Promise.withResolvers<string>();
  const test = await fixture(() => answer.promise);
  await test.session.start("offer-sdp");
  test.utterance("work");
  test.handoff("First work");
  const oldReply = test.request("first", "First work", "native-1");
  test.utterance("correction");
  test.handoff("Corrected work");
  await test.request("barrier", "", "native-1");
  answer.resolve("Obsolete result");
  expect(await oldReply).toContain("clarification");
  expect(test.speech).toEqual([]);
});

it("releases a result held during a status handoff only when its routing turn completes", async () => {
  const answer = Promise.withResolvers<string>();
  const test = await fixture(() => answer.promise, { speakInlineMs: 0 });
  await test.session.start("offer-sdp");
  test.handoff("Do the work");
  await test.request("work", "Do the work", "native-1");
  test.handoff("Are you still there?");
  test.notify("turn/started", { threadId: "test-thread", turn: { id: "status" } });
  await test.request("before-result", "", "native-1");
  answer.resolve("Held work result.");
  await answer.promise;
  await test.request("after-result", "", "native-1");
  expect(test.speech).toEqual([]);
  const speech = test.speechStarted();
  test.notify("turn/completed", {
    threadId: "test-thread",
    turn: { id: "status", status: "completed" },
  });
  expect(await speech).toBe("Held work result.");
});

it("drops a held result when routing actually calls the agent with a corrected instruction", async () => {
  const first = Promise.withResolvers<string>();
  const test = await fixture(
    (prompt) => (prompt === "First work" ? first.promise : Promise.resolve("Corrected result.")),
    { speakInlineMs: 0 },
  );
  await test.session.start("offer-sdp");
  test.handoff("First work");
  await test.request("first", "First work", "native-1");
  test.handoff("Corrected work");
  test.notify("turn/started", { threadId: "test-thread", turn: { id: "correction" } });
  await test.request("barrier", "", "native-1");
  first.resolve("Obsolete held result.");
  await first.promise;
  expect(await test.request("corrected", "Corrected work", "correction")).toBe("Corrected result.");
  test.notify("turn/completed", {
    threadId: "test-thread",
    turn: { id: "correction", status: "completed" },
  });
  await test.request("after-correction", "", "native-1");
  expect(test.speech).toEqual([]);
  expect(test.session.takeNotices()).not.toContain("Agent result: Obsolete held result.");
});

it("does not return a stale inline result after a new instruction", async () => {
  const first = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const test = await fixture(async (prompt) => {
    if (prompt === "First") {
      started.resolve();
      return first.promise;
    }
    return "Latest answer";
  });
  await test.session.start("offer-sdp");
  test.utterance("spoken-1");
  const oldReply = test.request("call-1", "First", "native-1");
  await started.promise;
  test.utterance("spoken-2");
  expect(await test.request("call-2", "Updated", "native-1")).toBe("Latest answer");
  first.resolve("Stale answer");
  expect(await oldReply).toContain("superseded");
});

it("rejects an entitlement error instead of mistaking its RPC acknowledgement for voice", async () => {
  const { session } = await fixture(async () => "unused", { mode: "error" });
  await expect(session.start("offer-sdp")).rejects.toThrow("Voice entitlement unavailable");
});

it("requires ChatGPT login without silently falling back to paid API authentication", async () => {
  const { session } = await fixture(async () => "unused", { mode: "apikey" });
  await expect(session.start("offer-sdp")).rejects.toThrow(
    "Sign in to Codex with your ChatGPT account",
  );
});

it("closes the call wait while preserving the work already dispatched to the task", async () => {
  const work = Promise.withResolvers<string>();
  const started = Promise.withResolvers<AbortSignal>();
  const test = await fixture(async (_prompt, signal) => {
    started.resolve(signal);
    return work.promise;
  });
  await test.session.start("offer-sdp");
  void test.request("call-1", "Work", "native-1");
  const signal = await started.promise;
  test.session.close();
  expect(signal.aborted).toBe(true);
  work.resolve("Work finished after the call ended.");
  expect(await work.promise).toBe("Work finished after the call ended.");
  expect(test.speech).toEqual([]);
  expect(test.session.renew()).toBe("Voice session ended.");
});

it("releases its host reservation once after the child ends on close or upstream failure", async () => {
  let closed = 0;
  const explicitClosed = Promise.withResolvers<void>();
  const test = await fixture(async () => "unused", {
    onClosed: () => {
      closed++;
      explicitClosed.resolve();
    },
  });
  await test.session.start("offer-sdp");
  test.session.close();
  test.session.close();
  await explicitClosed.promise;
  expect(closed).toBe(1);
  const failedClosed = Promise.withResolvers<void>();
  const failed = await fixture(async () => "unused", {
    mode: "error",
    onClosed: () => {
      closed++;
      failedClosed.resolve();
    },
  });
  await expect(failed.session.start("offer-sdp")).rejects.toThrow("Voice entitlement unavailable");
  failed.session.close();
  await failedClosed.promise;
  expect(closed).toBe(2);
});
