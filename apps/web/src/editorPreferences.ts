import {
  AuthOrchestrationOperateScope,
  EDITORS,
  EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

function resolvePreferredEditor(
  availableEditors: readonly EditorId[],
  stored: EditorId | null,
): EditorId | null {
  if (stored && availableEditors.includes(stored)) return stored;
  if (availableEditors.includes("vscode")) return "vscode";
  return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(
    () => resolvePreferredEditor(availableEditors, lastEditor),
    [lastEditor, availableEditors],
  );

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  const editor = resolvePreferredEditor(availableEditors, stored);
  if (editor === stored) return editor;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor;
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return useCallback(
    async (
      targetPath: string,
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | EnvironmentAuthorizationError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot open an editor on this environment.",
            }),
          ),
        );
      }
      const editor = resolveAndPersistPreferredEditor(availableEditors);
      if (!editor) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: availableEditors,
            }),
          ),
        );
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: targetPath,
          editor,
        },
      });
      return mapAtomCommandResult(result, () => editor);
    },
    [availableEditors, environmentId, openInEditor],
  );
}
