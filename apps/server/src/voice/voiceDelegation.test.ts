import { expect, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadManagementSendInput } from "../orchestration-v2/ThreadManagementService.ts";
import { delegateVoiceRequest, type VoiceDelegationThreads } from "./voiceDelegation.ts";

const THREAD_ID = ThreadId.make("thread-voice");
const RUN_ID = RunId.make("run-voice");

const makeShell = (overrides: Record<string, unknown> = {}): OrchestrationV2ThreadShell =>
  ({
    id: THREAD_ID,
    projectId: "project-voice",
    archivedAt: null,
    activeRunId: null,
    lastError: null,
    modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const makeRun = (status: OrchestrationV2Run["status"]): OrchestrationV2Run =>
  ({ id: RUN_ID, threadId: THREAD_ID, status }) as unknown as OrchestrationV2Run;

const assistant = (
  text: string,
  runId: RunId | null = RUN_ID,
  id = `message-${text.length}`,
): OrchestrationV2ConversationMessage =>
  ({
    id: MessageId.make(id),
    threadId: THREAD_ID,
    runId,
    role: "assistant",
    text,
  }) as unknown as OrchestrationV2ConversationMessage;

const makeThreads = (input: {
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly finalShell?: OrchestrationV2ThreadShell;
  readonly finalStatus?: OrchestrationV2Run["status"];
  readonly timedOut?: boolean;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly onSend?: (input: ThreadManagementSendInput) => void;
}): VoiceDelegationThreads => {
  let reads = 0;
  return {
    getThreadShell: () =>
      Effect.sync(() => {
        reads += 1;
        return reads > 1 && input.finalShell !== undefined ? input.finalShell : input.shell;
      }),
    sendToThread: (send) =>
      Effect.sync(() => {
        input.onSend?.(send);
        return { run: makeRun("running") } as never;
      }),
    waitForThread: () =>
      Effect.succeed({
        threadId: THREAD_ID,
        run: makeRun(input.finalStatus ?? "completed"),
        timedOut: input.timedOut ?? false,
      }),
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        thread: {},
        messages: (input.messages ?? []).filter(
          (message) =>
            filter?.messageRunIds === undefined ||
            (message.runId !== null && filter.messageRunIds.includes(message.runId)),
        ),
      } as never),
  };
};

it.effect("runs the spoken request as a turn and answers with the agent's text", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [assistant("17 times 23 is 391.")],
        onSend: (send) => sent.push(send),
      }),
      THREAD_ID,
      "What is seventeen times twenty-three?",
    );
    expect(answer).toBe("17 times 23 is 391.");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("What is seventeen times twenty-three?");
    // The task's own model selection decides who answers — never the voice layer.
    expect(sent[0]?.modelSelection).toBeUndefined();
  }),
);

it.effect("ignores messages from a run the request did not start", () =>
  Effect.gen(function* () {
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [
          assistant("leftover from the previous turn", RunId.make("run-earlier"), "m-1"),
          assistant("391", RUN_ID, "m-2"),
        ],
      }),
      THREAD_ID,
      "What is seventeen times twenty-three?",
    );
    expect(answer).toBe("391");
  }),
);

it.effect("joins every assistant message of the run and skips empty ones", () =>
  Effect.gen(function* () {
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        messages: [
          assistant("Checking.", RUN_ID, "m-1"),
          assistant("", RUN_ID, "m-2"),
          assistant("Done.", RUN_ID, "m-3"),
        ],
      }),
      THREAD_ID,
      "Anything",
    );
    expect(answer).toBe("Checking.\n\nDone.");
  }),
);

it.effect("surfaces a failed turn instead of speaking a made-up answer", () =>
  Effect.gen(function* () {
    const failure = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell(),
        finalShell: makeShell({ lastError: "Claude usage limit reached" }),
        finalStatus: "failed",
      }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(failure.message).toBe("Claude usage limit reached");
  }),
);

it.effect("delivers a new spoken instruction while the selected agent is working", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const answer = yield* delegateVoiceRequest(
      makeThreads({
        shell: makeShell({ activeRunId: RunId.make("run-busy") }),
        onSend: (send) => sent.push(send),
        messages: [assistant("Updated instruction applied.")],
      }),
      THREAD_ID,
      "Use the updated instruction",
    );
    expect(answer).toBe("Updated instruction applied.");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.mode).toBe("auto");
    expect(sent[0]?.text).toBe("Use the updated instruction");
  }),
);

it.effect("refuses to speak into an archived or missing task", () =>
  Effect.gen(function* () {
    const missing = yield* delegateVoiceRequest(
      makeThreads({ shell: null }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(missing._tag).toBe("VoiceApiError");
    expect(missing.message).toContain("active MT Code task");

    const archived = yield* delegateVoiceRequest(
      makeThreads({ shell: makeShell({ archivedAt: "2026-01-01T00:00:00.000Z" }) }),
      THREAD_ID,
      "Anything",
    ).pipe(Effect.flip);
    expect(archived.message).toContain("active MT Code task");
  }),
);

it.effect("reuses durable dispatch identity when one voice request is retried", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const threads = makeThreads({
      shell: makeShell(),
      messages: [assistant("Confirmed")],
      onSend: (send) => sent.push(send),
    });
    expect(
      yield* delegateVoiceRequest(threads, THREAD_ID, "Confirm", "voice-session:utterance-1"),
    ).toBe("Confirmed");
    expect(
      yield* delegateVoiceRequest(threads, THREAD_ID, "Confirm again", "voice-session:utterance-1"),
    ).toBe("Confirmed");
    expect(sent[0]?.commandId).toBe(sent[1]?.commandId);
    expect(sent[0]?.messageId).toBe(sent[1]?.messageId);
  }),
);

it.effect("sends identical words as separate work when the voice request identities differ", () =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagementSendInput> = [];
    const threads = makeThreads({
      shell: makeShell(),
      messages: [assistant("Confirmed")],
      onSend: (send) => sent.push(send),
    });
    yield* delegateVoiceRequest(threads, THREAD_ID, "Confirm", "voice-session:utterance-1");
    yield* delegateVoiceRequest(threads, THREAD_ID, "Confirm", "voice-session:utterance-2");
    expect(sent[0]?.commandId).not.toBe(sent[1]?.commandId);
    expect(sent[0]?.messageId).not.toBe(sent[1]?.messageId);
  }),
);

it.effect("leaves a timed-out task working and directs the user to its result", () =>
  Effect.gen(function* () {
    const failure = yield* delegateVoiceRequest(
      makeThreads({ shell: makeShell(), timedOut: true }),
      THREAD_ID,
      "Work on this request",
    ).pipe(Effect.flip);
    expect(failure.message).toContain("still working");
    expect(failure.message).toContain("Check the task");
  }),
);
