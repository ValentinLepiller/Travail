import { act, useLayoutEffect, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useVoiceSettingsStore } from "./voiceSettingsStore";
import { useVoiceTraceStore } from "./voiceTraceStore";
import {
  VoiceSessionProvider,
  useVoiceSession,
  type VoiceComposerRegistration,
} from "./VoiceSession";

const transport = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  command: vi.fn(),
  readThread: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => transport.command }));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  readThreadDetail: (ref: ScopedThreadRef) => {
    transport.readThread(ref);
    return null;
  },
}));
vi.mock("./CodexVoiceConnection", () => ({
  CodexVoiceConnection: class {
    microphoneStream = null;
    speakerStream = null;
    connect(input: { threadId: ThreadId; onEvent: (event: unknown) => void }) {
      return transport.connect(input);
    }
    close() {
      transport.close();
    }
    send(value: unknown) {
      transport.send(value);
    }
    setMuted() {}
  },
}));
vi.mock("./OpenAIRealtimeConnection", () => ({
  OpenAIRealtimeConnection: class {
    connect() {
      throw new Error("Paid API transport is forbidden in these tests.");
    }
  },
}));
vi.mock("./useVoicePanelGeometry", () => ({
  useVoicePanelGeometry: () => ({ style: {}, moveHandlers: {}, resizeHandlers: () => ({}) }),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./VoiceTraceTimeline", () => ({ VoiceTraceTimeline: () => null }));

const environmentId = EnvironmentId.make("voice-draft-environment");
const projectId = ProjectId.make("voice-draft-project");
const draftId = DraftId.make("voice-draft-fixture");
const provisionalRef = { environmentId, threadId: ThreadId.make("draft-reserved-thread") };
const durableRef = { environmentId, threadId: ThreadId.make("durable-created-thread") };
const prompt = "Keep this unsent prompt while I start a voice conversation.";
let renderer: ReactTestRenderer | undefined;
let voice: ReturnType<typeof useVoiceSession>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({ registration }: { registration: VoiceComposerRegistration }) {
  const session = useVoiceSession();
  const { registerComposer } = session;
  useLayoutEffect(() => {
    voice = session;
  });
  useLayoutEffect(() => registerComposer(registration), [registration, registerComposer]);
  return null;
}
const render = async (prepareThread: () => Promise<ScopedThreadRef>) => {
  const registration: VoiceComposerRegistration = {
    environmentId,
    threadRef: provisionalRef,
    composerDraftTarget: draftId,
    composerRef: { current: null },
    title: "Draft voice fixture",
    prepareThread,
  };
  await act(async () => {
    renderer = create(
      <VoiceSessionProvider>
        <Probe registration={registration} />
      </VoiceSessionProvider>,
    );
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  transport.connect.mockImplementation(async (input: { onEvent: (event: unknown) => void }) => {
    input.onEvent({ type: "session.started" });
    return {};
  });
  useVoiceSettingsStore.getState().setProvider("codex-account");
  useVoiceTraceStore.getState().clearHistory();
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId({ environmentId, projectId }, draftId, {
    threadId: provisionalRef.threadId,
  });
  store.setPrompt(draftId, prompt);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  useComposerDraftStore.getState().clearDraftThread(draftId);
  useComposerDraftStore.getState().clearDraftThread(durableRef);
  useVoiceTraceStore.getState().clearHistory();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("draft voice startup", () => {
  it("waits for a durable thread before connecting and preserves the unsent prompt through promotion", async () => {
    const created = deferred<ScopedThreadRef>();
    const prepare = vi.fn(async () => {
      const ref = await created.promise;
      const store = useComposerDraftStore.getState();
      store.markDraftThreadPromoting(draftId, ref);
      store.finalizePromotedDraftThread(draftId);
      return ref;
    });
    await render(prepare);
    await act(async () => voice.start());
    expect(voice.status).toBe("connecting");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(transport.connect).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(prompt);
    await act(async () => {
      created.resolve(durableRef);
      await created.promise;
    });
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect.mock.calls[0]?.[0].threadId).toBe(durableRef.threadId);
    expect(transport.readThread).toHaveBeenCalledWith(durableRef);
    expect(useVoiceTraceStore.getState().sessions[0]?.threadId).toBe(durableRef.threadId);
    expect(useComposerDraftStore.getState().getComposerDraft(durableRef)?.prompt).toBe(prompt);
    expect(transport.command).not.toHaveBeenCalled();
    expect(voice.status).toBe("listening");
  });

  it("coalesces two start clicks into one draft preparation and one voice call", async () => {
    const created = deferred<ScopedThreadRef>();
    const prepare = vi.fn(() => created.promise);
    await render(prepare);
    await act(async () => {
      voice.start();
      voice.start();
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(transport.connect).not.toHaveBeenCalled();
    await act(async () => {
      created.resolve(durableRef);
      await created.promise;
    });
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  it("does not connect if the call is ended while draft creation is pending", async () => {
    const created = deferred<ScopedThreadRef>();
    await render(() => created.promise);
    await act(async () => voice.start());
    await act(async () => voice.end());
    await act(async () => {
      created.resolve(durableRef);
      await created.promise;
    });
    expect(transport.connect).not.toHaveBeenCalled();
    expect(voice.status).toBe("idle");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(prompt);
  });

  it("does not let an older creation result start or close a later voice call", async () => {
    const older = deferred<ScopedThreadRef>();
    const newer = deferred<ScopedThreadRef>();
    const prepare = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    await render(prepare);
    await act(async () => voice.start());
    await act(async () => voice.end());
    await act(async () => voice.start());
    expect(prepare).toHaveBeenCalledTimes(2);
    await act(async () => {
      older.resolve(provisionalRef);
      await older.promise;
    });
    expect(transport.connect).not.toHaveBeenCalled();
    await act(async () => {
      newer.resolve(durableRef);
      await newer.promise;
    });
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect.mock.calls[0]?.[0].threadId).toBe(durableRef.threadId);
    expect(transport.close).not.toHaveBeenCalled();
    expect(voice.status).toBe("listening");
  });

  it("ignores an older creation failure while a later call is active", async () => {
    const older = deferred<ScopedThreadRef>();
    const prepare = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(durableRef);
    await render(prepare);
    await act(async () => voice.start());
    await act(async () => voice.end());
    await act(async () => voice.start());
    expect(voice.status).toBe("listening");
    await act(async () => {
      older.reject(new Error("Old draft creation failed"));
      await older.promise.catch(() => {});
    });
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.close).not.toHaveBeenCalled();
    expect(voice.status).toBe("listening");
    expect(voice.errorMessage).toBeNull();
  });
});
