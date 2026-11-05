import { useRequestDraft } from "../../hooks/useRequestDraft";
import { useAtomValue } from "@effect/atom-react";
import type { AgentRequest, EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useRef, useState } from "react";
import { MessageCircleIcon, SendIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  clearRequestChat,
  requestChat,
  sendRequestChat,
  stopRequestChat,
} from "../../state/agentRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { defaultRequestChatModel } from "./requestChatModel";
import { randomUUID } from "../../lib/utils";

const suggestions = [
  "Je n’ai aucun contexte sur cette demande. Réexplique-moi simplement de quoi on parle et quel est le blocage.",
  "Qu’a-t-on déjà décidé sur ce sujet ?",
  "Quelles sont les options et leurs conséquences ?",
];

export function RequestTemporaryChat({
  request,
  environmentId,
  onUseDraft,
}: {
  request: AgentRequest;
  environmentId: EnvironmentId;
  onUseDraft: (text: string) => void;
}) {
  const query = useEnvironmentQuery(requestChat({ environmentId, input: { id: request.id } }));
  const chat = query.data;
  const settings = useEnvironmentSettings(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const thread = useThreadShell(scopeThreadRef(environmentId, request.threadId));
  const providers = (config?.providers ?? EMPTY_SERVER_PROVIDERS).filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providers),
      settings,
      thread?.projectId ?? null,
    ),
  );
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const selection = selectedModel ?? chat?.modelSelection ?? defaultRequestChatModel(entries);
  const pickerSelection = selection ?? NO_PROVIDER_MODEL_SELECTION;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const selectedEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const available =
    selectedEntry?.enabled &&
    selectedEntry.isAvailable &&
    selectedEntry.status === "ready" &&
    modelOptions
      .get(selectedEntry.instanceId)
      ?.some((model) => model.slug === selection?.model && !model.isUnavailable);
  const canSend = useAtomValue(sendRequestChat.permissionAtom(environmentId));
  const canStop = useAtomValue(stopRequestChat.permissionAtom(environmentId));
  const canClear = useAtomValue(clearRequestChat.permissionAtom(environmentId));
  const send = useAtomCommand(sendRequestChat);
  const stop = useAtomCommand(stopRequestChat);
  const clear = useAtomCommand(clearRequestChat);
  const { text, setText, clearSubmitted } = useRequestDraft(
    environmentId,
    request,
    "temporaryDrafts",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const running = chat?.activeMessageId != null;
  const lastMessageId = chat?.messages.at(-1)?.id;

  useEffect(() => {
    if (lastMessageId || running) bottom.current?.scrollIntoView({ block: "end" });
  }, [lastMessageId, running]);

  const submit = async () => {
    if (busy || running || !selection || !available || !canSend || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await send({
        environmentId,
        input: {
          id: request.id,
          messageId: randomUUID(),
          text: text.trim(),
          modelSelection: selection,
        },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else clearSubmitted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderModelPicker
            environmentId={environmentId}
            activeInstanceId={pickerSelection.instanceId}
            model={pickerSelection.model}
            triggerAriaLabel="Modèle de la discussion temporaire"
            {...(!selection ? { triggerLabel: "Choisir un modèle" } : {})}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptions}
            disabled={busy || running}
            onInstanceModelChange={(instanceId, model) =>
              setSelectedModel(createModelSelection(instanceId, model))
            }
          />
          {selection && selectedEntry && (
            <TraitsPicker
              provider={selectedEntry.driverKind}
              models={selectedEntry.models}
              model={selection.model}
              modelOptions={selection.options ?? []}
              prompt=""
              onPromptChange={() => {}}
              allowPromptInjectedEffort={false}
              planModeEnabled={false}
              disabled={busy || running}
              onModelOptionsChange={(options) =>
                setSelectedModel(
                  createModelSelection(selection.instanceId, selection.model, options),
                )
              }
            />
          )}
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Effacer la discussion temporaire"
              disabled={busy || running || !canClear || !chat?.messages.length}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const result = await clear({ environmentId, input: { id: request.id } });
                  if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Discussion d’origine complète et requête en contexte. Cet échange reste séparé.
        </p>
        {chat?.sourceVersion != null && chat.sourceVersion !== request.version && (
          <p role="status" className="text-xs text-muted-foreground">
            La requête a évolué. Ta prochaine question utilisera sa nouvelle version.
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!chat && !query.error && (
          <p role="status" className="text-sm text-muted-foreground">
            Chargement…
          </p>
        )}
        {chat && chat.messages.length === 0 && (
          <div className="flex flex-col gap-3 py-5">
            <MessageCircleIcon className="size-6 text-muted-foreground" />
            <p className="text-sm">Pose ta question librement, ou pars d’une suggestion.</p>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="rounded-lg border p-3 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  setText(suggestion);
                  editor.current?.focus();
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <div
          role="log"
          aria-label="Messages de la discussion temporaire"
          className="flex flex-col gap-5"
        >
          {chat?.messages.map((message) => (
            <div
              key={message.id}
              className={message.role === "user" ? "ml-6 rounded-xl bg-muted p-3" : "min-w-0"}
            >
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {message.role === "user" ? "Toi" : "Assistant"}
              </p>
              <ChatMarkdown
                text={message.text}
                cwd={undefined}
                environmentId={environmentId}
                threadRef={{ environmentId, threadId: request.threadId }}
              />
              {message.role === "assistant" && request.status === "pending" && (
                <div className="mt-2">
                  <Button variant="ghost" size="sm" onClick={() => onUseDraft(message.text)}>
                    Reprendre dans ma réponse
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        {running && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            L’assistant prépare sa réponse…
          </p>
        )}
        {(query.error || error || chat?.error) && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {query.error || error || chat?.error}
          </p>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="flex shrink-0 flex-col gap-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!available && chat && (
          <p role="status" className="text-xs text-muted-foreground">
            Choisis un modèle disponible pour démarrer la discussion.
          </p>
        )}
        <Textarea
          ref={editor}
          autoFocus
          aria-label="Message à l’assistant temporaire"
          placeholder="Pose ta question…"
          value={text}
          maxLength={20_000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex justify-end">
          {running ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !canStop}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await stop({ environmentId, input: { id: request.id } });
                  if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <SquareIcon className="size-4" />
              Arrêter
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!chat || busy || !available || !canSend || !text.trim()}
            >
              <SendIcon className="size-4" />
              Envoyer
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
