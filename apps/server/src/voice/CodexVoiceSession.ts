// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
// This Promise adapter owns a JSON-RPC child and its timers; the enclosing Effect scope closes it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const ToolCall = Schema.Struct({
  tool: Schema.String,
  arguments: Schema.Unknown,
  callId: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
});
const Prompt = Schema.Struct({ prompt: Schema.String });
const Sdp = Schema.Struct({ sdp: Schema.String });
const Failure = Schema.Struct({ message: Schema.String });
const Thread = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) });
const Account = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({ type: Schema.String })),
});

const RealtimeItem = Schema.Struct({
  item: Schema.Struct({
    type: Schema.String,
    item_id: Schema.optionalKey(Schema.String),
    turn: Schema.optionalKey(Schema.Struct({ id: Schema.String, role: Schema.String })),
    input_transcript: Schema.optionalKey(Schema.String),
    active_transcript: Schema.optionalKey(
      Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
    ),
  }),
});
const decodeEnvelope = Schema.decodeUnknownSync(Envelope);
const decodeToolCall = Schema.decodeUnknownSync(ToolCall);
const decodePrompt = Schema.decodeUnknownSync(Prompt);
const decodeSdp = Schema.decodeUnknownSync(Sdp);
const decodeFailure = Schema.decodeUnknownSync(Failure);
const decodeThread = Schema.decodeUnknownSync(Thread);
const decodeAccount = Schema.decodeUnknownSync(Account);
const decodeRealtimeItem = Schema.decodeUnknownOption(RealtimeItem);
const decodeRoutingTurn = Schema.decodeUnknownOption(
  Schema.Struct({
    threadId: Schema.String,
    turn: Schema.Struct({ id: Schema.String, status: Schema.optionalKey(Schema.String) }),
  }),
);
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const CODEX_VOICE_INSTRUCTIONS =
  "You are MT Code's conversational voice bridge. Handle greetings, clarification, work-status " +
  "questions, and repeating a result already received directly. For new reasoning, factual answers, " +
  "or work requests, call ask_selected_agent with the complete request and relevant spoken context. " +
  "The selected agent owns reasoning, tools, files, and approvals. Never do its work yourself or " +
  "use other tools. Briefly acknowledge a delegated request and remain conversational while the " +
  "agent works. A status question does not resend the task; a changed instruction must reach the " +
  "agent. Speak its final result faithfully and concisely when it arrives. Never claim work succeeded " +
  "before receiving the result, and explain a tool failure honestly.";

/** Keep synchronous replies inline without silencing a call while an agent works. */
const ANSWER_INLINE_MS = 250;

/** How long a fresh ping is treated as a repeat of the question just answered. */
const REPEAT_PING_MS = 30_000;

export interface CodexVoiceOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean;
  readonly cwd: string;
  readonly askAgent: (prompt: string, signal: AbortSignal, requestId: string) => Promise<string>;
  /** Releases the host resource reservation once the actual call has ended. */
  readonly onClosed?: () => void;
  readonly speechDelayMs?: number;
  /** Overridable so tests do not wait out the real threshold. */
  readonly speakInlineMs?: number;
}

/** Owns only the child it starts. Credentials stay inside the authenticated Codex runtime. */
export class CodexVoiceSession {
  readonly id = NodeCrypto.randomUUID();
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly abort = new AbortController();
  private sequence = 0;
  private threadId: string | undefined;
  private closed = false;
  private failure: string | undefined;
  private lease: ReturnType<typeof setTimeout> | undefined;
  private delegation: Promise<string> | undefined;
  private delegationPrompt: string | undefined;
  private revision = 0;
  private speechTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly handoffs = new Set<string>();
  private spokenSource: { readonly key: string; readonly prompt: string } | undefined;
  private utteranceId: string | undefined;
  private answerSourceKey: string | undefined;
  private routingTurnId: string | undefined;
  private pendingHandoff: { readonly turnId: string | undefined } | undefined;
  private queuedAnswer:
    | { readonly text: string; readonly prompt: string; readonly revision: number }
    | undefined;
  private deliveredRevision = 0;
  private latestHandoffKey: string | undefined;
  private notices: string[] = [];
  private delivered: string | undefined;
  /** The request `delivered` answers; only a repeat of it may reuse that answer. */
  private deliveredPrompt: string | undefined;
  private deliveredAt = 0;
  private ready: { resolve: (sdp: string) => void; reject: (error: Error) => void } | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly options: CodexVoiceOptions;

  constructor(options: CodexVoiceOptions) {
    this.options = options;
    this.child = NodeChildProcess.spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: "pipe",
      windowsHide: true,
    });
    // stderr can contain upstream headers or account details; never forward it to clients.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail("The Codex voice connection closed."));
    this.child.on("error", () =>
      this.fail("Could not start Codex. Check the Codex provider's binary path."),
    );
    this.child.on("exit", () => {
      if (!this.closed) this.fail("Codex exited during the voice session.");
    });
    const lines = NodeReadline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = decodeEnvelope(JSON.parse(line));
        if (message.method && message.id !== undefined) {
          void this.handleRequest(message.id, message.method, message.params);
        } else if (typeof message.id === "number") {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        } else if (message.method === "turn/started" || message.method === "turn/completed") {
          this.observeRoutingTurn(message.method, message.params);
        } else if (message.method === "thread/realtime/itemAdded") {
          this.observeRealtimeItem(message.params);
        } else if (message.method === "thread/realtime/sdp") {
          this.ready?.resolve(decodeSdp(message.params).sdp);
        } else if (message.method === "thread/realtime/error") {
          this.fail(decodeFailure(message.params).message);
        } else if (message.method === "thread/realtime/closed" && !this.closed) {
          this.fail("The Codex voice session ended. Start voice again to reconnect.");
        }
      } catch {
        this.fail("Codex returned an incompatible voice protocol. Update Codex and try again.");
      }
    });
    this.renew();
  }

  private send(value: unknown) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.failure ?? "Voice session ended."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out while handling ${method}.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private observeRealtimeItem(params: unknown): void {
    const decoded = decodeRealtimeItem(params);
    if (Option.isNone(decoded)) return;
    const { item } = decoded.value;
    // Speech boundaries identify retries, not replacement work: conversation
    // during a task must preserve its pending result until a new handoff supersedes it.
    if (item.type === "input_audio_buffer.speech_started" && item.item_id) {
      if (this.utteranceId === item.item_id) return;
      this.utteranceId = item.item_id;
      this.spokenSource = undefined;
    } else if (item.type === "turn.created" && item.turn?.role === "user") {
      if (this.utteranceId === item.turn.id) return;
      this.utteranceId = item.turn.id;
      this.spokenSource = undefined;
    } else if (item.type === "handoff_request") {
      const users = (item.active_transcript ?? [])
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.text.trim());
      const prompt = item.input_transcript?.trim() || users.at(-1);
      if (!prompt || prompt.length > 32_000) return;
      // The current transcript can advance before the history tail catches up.
      const key = digest(JSON.stringify({ users, prompt }));
      if (
        this.spokenSource?.key !== key &&
        this.answerSourceKey !== undefined &&
        this.answerSourceKey !== key
      ) {
        // A handoff also routes conversation. Wait for its tool decision before replacing work.
        this.pendingHandoff = { turnId: this.routingTurnId };
        clearTimeout(this.speechTimer);
      }
      this.spokenSource = { key, prompt };
    }
  }

  private observeRoutingTurn(method: string, params: unknown): void {
    const decoded = decodeRoutingTurn(params);
    if (Option.isNone(decoded) || decoded.value.threadId !== this.threadId) return;
    const { turn } = decoded.value;
    if (method === "turn/started") {
      this.routingTurnId = turn.id;
      if (this.pendingHandoff) this.pendingHandoff = { turnId: turn.id };
      return;
    }
    if (this.routingTurnId === turn.id) this.routingTurnId = undefined;
    if (this.pendingHandoff?.turnId !== turn.id) return;
    this.pendingHandoff = undefined;
    if (turn.status !== "completed") {
      this.notices.push("Voice clarification did not complete. Check the task for its result.");
      return;
    }
    const answer = this.queuedAnswer;
    if (answer) this.deliver(answer.text, answer.prompt, answer.revision);
  }

  private invalidateAnswer(): void {
    ++this.revision;
    clearTimeout(this.speechTimer);
    this.queuedAnswer = undefined;
    this.pendingHandoff = undefined;
  }

  /** Waits for the latest instruction; the task service owns steering and queued delivery. */
  private ask(prompt: string, requestId: string): Promise<string> {
    const delegation = this.options.askAgent(prompt, this.abort.signal, requestId);
    this.delegation = delegation;
    this.delegationPrompt = prompt;
    void delegation
      .catch(() => undefined)
      .finally(() => {
        if (this.delegation === delegation) this.delegation = undefined;
      });
    return delegation;
  }

  private rememberAnswer(text: string, prompt: string, revision: number): void {
    this.deliveredRevision = revision;
    this.delivered = text;
    this.deliveredPrompt = prompt;
    this.deliveredAt = Date.now();
    this.notices.push(`Agent result: ${text.slice(0, 4_000)}`);
  }

  /**
   * Append a late answer to realtime context while keeping its exact text in notices. GPT-Live will not hold a
   * tool call for the minute an agent turn can take, so a late answer comes back
   * as context. Older runtimes may accept that context without speaking it.
   */
  private deliver(text: string, prompt: string, revision: number): void {
    if (revision !== this.revision) return;
    if (this.closed || !this.threadId || text.trim().length === 0) return;
    // One reply per answer: GPT-Live raises several pings for one question and
    // each waits on the same turn, so without this it would say it twice. A
    // different question that happens to get the same answer is still spoken.
    if (this.deliveredRevision === revision) return;
    this.queuedAnswer = { text, prompt, revision };
    if (this.pendingHandoff) return;
    // A beat first: pushing speech while GPT-Live is still finishing its own
    // line gets swallowed.
    clearTimeout(this.speechTimer);
    this.speechTimer = setTimeout(() => {
      if (this.closed || !this.threadId || revision !== this.revision || this.pendingHandoff)
        return;
      this.queuedAnswer = undefined;
      this.rememberAnswer(text, prompt, revision);
      void this.request("thread/realtime/appendSpeech", {
        threadId: this.threadId,
        text,
      }).catch((error: unknown) => {
        // The answer is already in the task, so a failed read-out is not fatal.
        this.notices.push(
          `Could not deliver the answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.options.speechDelayMs ?? 2_500);
    this.speechTimer.unref?.();
  }

  private async handleRequest(id: string | number, method: string, params: unknown) {
    try {
      if (method !== "item/tool/call")
        throw new Error(
          "Use only ask_selected_agent. Approvals belong to the selected MT Code task.",
        );
      const call = decodeToolCall(params);
      if (call.tool !== "ask_selected_agent") throw new Error("Unknown voice bridge tool.");
      const { prompt } = decodePrompt(call.arguments);
      if (!prompt.trim() || prompt.length > 32_000)
        throw new Error("The voice request is empty or too long.");
      // Return fast answers through the native tool; only slow replies use
      // appendSpeech, whose speakable-context support varies by Codex version.
      const reply = (text: string) =>
        this.send({ id, result: { success: true, contentItems: [{ type: "inputText", text }] } });
      const askedPrompt = this.spokenSource?.prompt ?? prompt.trim();
      // The current installed runtime can omit speech boundaries. Its source
      // transcript still deduplicates paraphrased retries and distinguishes changed
      // instructions, but an identical repeat within one native turn is ambiguous.
      const handoffKey = this.utteranceId
        ? `utterance:${this.utteranceId}:${this.spokenSource?.key ?? "no-source"}`
        : call.turnId
          ? `turn:${call.turnId}:${this.spokenSource?.key ?? "no-source"}`
          : call.callId
            ? `call:${call.callId}`
            : undefined;
      if (handoffKey && this.handoffs.has(handoffKey)) {
        this.notices.push("Repeated handoff; request already delivered");
        reply(
          this.latestHandoffKey === handoffKey &&
            this.deliveredRevision === this.revision &&
            this.delivered !== undefined
            ? this.delivered
            : "Already asked. The selected agent is still working; its final answer will arrive separately.",
        );
        return;
      }

      // Only a repeat of the request just answered reuses the answer; a new
      // question asked within the window must still reach the agent.
      if (
        handoffKey === undefined &&
        this.delivered !== undefined &&
        this.deliveredPrompt === askedPrompt &&
        Date.now() - this.deliveredAt < REPEAT_PING_MS
      ) {
        this.notices.push("Repeat ping; reused the answer already given");
        reply(`The agent already answered: ${this.delivered}`);
        return;
      }
      if (handoffKey === undefined && this.delegation && this.delegationPrompt === askedPrompt) {
        this.notices.push("Repeat ping while the agent works; ignored");
        reply(
          "Already asked, still waiting. Say nothing more; the answer will arrive as a message.",
        );
        return;
      }
      if (handoffKey) {
        this.handoffs.add(handoffKey);
        if (this.handoffs.size > 64) this.handoffs.delete(this.handoffs.values().next().value!);
      }
      const updating = this.delegation !== undefined;
      this.invalidateAnswer();
      const revision = this.revision;
      this.answerSourceKey = this.spokenSource?.key;
      this.latestHandoffKey = handoffKey;
      clearTimeout(this.speechTimer);
      this.notices.push(
        updating ? "Updated the active task" : "Asked the agent; waiting for its reply",
      );
      const requestId = `${this.id}:${digest(handoffKey ?? NodeCrypto.randomUUID())}`;
      const work = this.ask(askedPrompt, requestId);
      const waiting = Symbol("waiting");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortWait!: () => void;
      const wait = new Promise<typeof waiting>((resolve) => {
        abortWait = () => resolve(waiting);
        this.abort.signal.addEventListener("abort", abortWait, { once: true });
        timer = setTimeout(abortWait, this.options.speakInlineMs ?? ANSWER_INLINE_MS);
        timer.unref?.();
      });
      let answer: string | typeof waiting;
      try {
        answer = await Promise.race([work, wait]);
      } finally {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", abortWait);
      }
      if (this.closed) return;
      if (revision !== this.revision) {
        reply("This request was superseded. Use only the latest instruction's result.");
        return;
      }
      if (answer !== waiting) {
        if (this.pendingHandoff) {
          reply(
            "The selected agent's result will arrive separately after the current clarification.",
          );
          this.deliver(answer, askedPrompt, revision);
          return;
        }
        this.rememberAnswer(answer, askedPrompt, revision);
        reply(answer);
        return;
      }
      reply(
        updating
          ? "Sent the updated instruction to the agent. Its final answer will arrive separately."
          : "The selected agent is working. Its final answer will arrive separately.",
      );
      void work.then(
        (text) => this.deliver(text, askedPrompt, revision),
        (error) =>
          this.deliver(
            `It could not finish: ${error instanceof Error ? error.message : "unknown error"}`,
            askedPrompt,
            revision,
          ),
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "The selected agent could not answer.";
      // Say why in the panel: a tool failure is otherwise invisible to the user.
      this.notices.push(text);
      this.send(
        method === "item/tool/call"
          ? { id, result: { success: false, contentItems: [{ type: "inputText", text }] } }
          : { id, error: { code: -32601, message: text } },
      );
    }
  }

  async start(sdp: string, voice?: string): Promise<string> {
    try {
      await this.request("initialize", {
        clientInfo: { name: "mt_code_voice", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: "initialized" });
      const account = decodeAccount(await this.request("account/read", {}));
      if (account.account?.type !== "chatgpt") {
        throw new Error(
          "Sign in to Codex with your ChatGPT account in Settings → Providers before starting account voice.",
        );
      }
      const thread = decodeThread(
        await this.request("thread/start", {
          ephemeral: true,
          cwd: this.options.cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: CODEX_VOICE_INSTRUCTIONS,
          config: { "features.shell_tool": false, web_search: "disabled" },
          dynamicTools: [
            {
              type: "function",
              name: "ask_selected_agent",
              description:
                "Start or update work with the selected model in the current MT Code task. A pending acknowledgement means the final result will arrive separately.",
              inputSchema: {
                type: "object",
                properties: { prompt: { type: "string" } },
                required: ["prompt"],
                additionalProperties: false,
              },
            },
          ],
        }),
      );
      this.threadId = thread.thread.id;
      const answer = new Promise<string>((resolve, reject) => {
        this.ready = { resolve, reject };
      });
      // Attach the handler before starting: SDP and failures arrive asynchronously after the RPC ack.
      const timeout = setTimeout(
        () => this.fail("Codex did not establish a voice connection in time."),
        35_000,
      );
      try {
        const [, answerSdp] = await Promise.all([
          this.request("thread/realtime/start", {
            threadId: this.threadId,
            outputModality: "audio",
            version: "v3",
            transport: { type: "webrtc", sdp },
            includeStartupContext: false,
            clientManagedHandoffs: false,
            // Native acknowledgement keeps speech independent of the routing turn.
            // The bridge still owns the exact result and its separate read-out.
            delegationAckFiller: true,
            ...(voice ? { voice } : {}),
            prompt: CODEX_VOICE_INSTRUCTIONS,
          }),
          answer,
        ]);
        return answerSdp;
      } finally {
        clearTimeout(timeout);
        this.ready = undefined;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Progress worth showing in the panel, drained by the client's heartbeat. */
  takeNotices(): ReadonlyArray<string> {
    return this.notices.splice(0);
  }

  renew(): string | undefined {
    if (this.closed) return this.failure ?? "Voice session ended.";
    clearTimeout(this.lease);
    this.lease = setTimeout(() => this.fail("Voice disconnected from MT Code."), 60_000);
    this.lease.unref();
    return this.failure;
  }

  private fail(message: string) {
    if (this.closed) return;
    this.failure = message;
    this.close();
  }

  close() {
    if (this.closed) return;
    if (this.threadId)
      this.send({
        id: ++this.sequence,
        method: "thread/realtime/stop",
        params: { threadId: this.threadId },
      });
    this.closed = true;
    clearTimeout(this.lease);
    clearTimeout(this.speechTimer);
    this.abort.abort();
    const error = new Error(this.failure ?? "Voice session ended.");
    this.ready?.reject(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.handoffs.clear();
    this.child.stdin.end();
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 2_000);
    killTimer.unref();
    const closed = () => {
      clearTimeout(killTimer);
      this.options.onClosed?.();
    };
    // Admission remains reserved while the child is still shutting down.
    if (
      this.child.pid === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      closed();
    } else {
      this.child.once("exit", closed);
    }
  }
}
