import { type OrchestrationV2ThreadLaunchInput, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CreateThreadInput } from "@t3tools/client-runtime/state/threads";

interface Preparation {
  readonly ref: ScopedThreadRef;
  readonly input: Omit<OrchestrationV2ThreadLaunchInput, "initialMessage">;
  readonly exists: () => boolean;
  readonly create: (input: CreateThreadInput) => Promise<void>;
  readonly launch: (input: OrchestrationV2ThreadLaunchInput) => Promise<void>;
  readonly waitForWorkspace: () => Promise<void>;
  readonly waitForShell: () => Promise<boolean>;
  readonly promote: () => void;
  readonly navigate: () => Promise<void>;
}

/** A voice draft becomes durable without dispatching a text turn. */
export function createVoiceThreadPreparation() {
  const pending = new Map<string, Promise<ScopedThreadRef>>();
  return (preparation: Preparation): Promise<ScopedThreadRef> => {
    const key = scopedThreadKey(preparation.ref);
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      const { input } = preparation;
      if (input.workspaceStrategy.type === "worktree") {
        await preparation.launch(input);
        await preparation.waitForWorkspace();
      } else if (!preparation.exists()) {
        await preparation.create({
          commandId: input.commandId,
          threadId: preparation.ref.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: input.workspaceStrategy.branch ?? null,
          worktreePath:
            input.workspaceStrategy.type === "existing_worktree"
              ? input.workspaceStrategy.worktreePath
              : null,
        });
      }
      if (!(await preparation.waitForShell())) {
        throw new Error(
          "The conversation was created, but has not reached this client. Reconnect and try again.",
        );
      }
      preparation.promote();
      await preparation.navigate();
      return preparation.ref;
    })();
    pending.set(key, work);
    const clear = () => {
      if (pending.get(key) === work) pending.delete(key);
    };
    void work.then(clear, clear);
    return work;
  };
}
