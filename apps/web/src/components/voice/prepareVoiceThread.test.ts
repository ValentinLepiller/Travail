import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import {
  DraftId,
  useComposerDraftStore,
  markPromotedDraftThreadByRef,
  finalizePromotedDraftThreadByRef,
} from "../../composerDraftStore";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CreateThreadInput } from "@t3tools/client-runtime/state/threads";
import { createVoiceThreadPreparation } from "./prepareVoiceThread";

const environmentId = EnvironmentId.make("voice-env");
const projectId = ProjectId.make("selected-project");
const ref = scopeThreadRef(environmentId, ThreadId.make("voice-thread"));
const draftId = DraftId.make("voice-draft");
const input: OrchestrationV2ThreadLaunchInput = {
  commandId: CommandId.make("voice-create:voice-thread"),
  threadId: ref.threadId,
  projectId,
  title: "New task",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = () => {
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId: ref.threadId,
  });
  store.setPrompt(draftId, "Keep this unsent prompt");
  return {
    ref,
    input,
    exists: () => false,
    create: vi.fn(async (_input: CreateThreadInput) => {}),
    launch: vi.fn(async (_input: OrchestrationV2ThreadLaunchInput) => {}),
    waitForWorkspace: vi.fn(async () => {}),
    waitForShell: vi.fn(async () => true),
    promote: () => markPromotedDraftThreadByRef(ref),
    navigate: vi.fn(async () => {}),
  };
};
beforeEach(() =>
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  }),
);

it("materializes the selected project/model without a message and retains the unsent draft after navigation", async () => {
  const preparation = fixture();
  expect(await createVoiceThreadPreparation()(preparation)).toEqual(ref);
  expect(preparation.create).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: ref.threadId,
      projectId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  );
  expect(preparation.create.mock.calls[0]?.[0]).not.toHaveProperty("initialMessage");
  expect(preparation.launch).not.toHaveBeenCalled();
  expect(preparation.navigate).toHaveBeenCalledOnce();
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
    "Keep this unsent prompt",
  );
  finalizePromotedDraftThreadByRef(ref);
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
    "Keep this unsent prompt",
  );
});

it("coalesces double clicks and waits for durable creation before promotion", async () => {
  const preparation = fixture();
  const gate = deferred();
  preparation.create = vi.fn(() => gate.promise);
  const ensure = createVoiceThreadPreparation();
  const first = ensure(preparation);
  const second = ensure(preparation);
  expect(second).toBe(first);
  expect(preparation.create).toHaveBeenCalledOnce();
  expect(preparation.navigate).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toBeFalsy();
  gate.resolve();
  await first;
  expect(preparation.navigate).toHaveBeenCalledOnce();
});

it("awaits real worktree preparation before handing a conversation to voice", async () => {
  const preparation = fixture();
  preparation.input = { ...input, workspaceStrategy: { type: "worktree", baseRef: "main" } };
  const gate = deferred();
  const entered = deferred();
  preparation.waitForWorkspace = vi.fn(() => {
    entered.resolve();
    return gate.promise;
  });
  const pending = createVoiceThreadPreparation()(preparation);
  await entered.promise;
  expect(preparation.launch).toHaveBeenCalledWith(preparation.input);
  expect(preparation.launch.mock.calls[0]?.[0]).not.toHaveProperty("initialMessage");
  expect(preparation.create).not.toHaveBeenCalled();
  expect(preparation.navigate).not.toHaveBeenCalled();
  gate.resolve();
  expect(await pending).toEqual(ref);
});

it("recovers a committed creation after a lost response without creating another conversation or clearing text", async () => {
  const preparation = fixture();
  let persisted = false;
  preparation.exists = () => persisted;
  preparation.create = vi.fn(async () => {
    persisted = true;
    throw new Error("Lost response");
  });
  const ensure = createVoiceThreadPreparation();
  await expect(ensure(preparation)).rejects.toThrow("Lost response");
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep this unsent prompt",
  );
  expect(await ensure(preparation)).toEqual(ref);
  expect(preparation.create).toHaveBeenCalledOnce();
});
