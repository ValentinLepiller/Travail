import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type {
  ChefCommand,
  ChefDossier,
  ChefMemory,
  ChefSettings,
  EnvironmentId,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import {
  BookOpenIcon,
  ChefHatIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  SettingsIcon,
  FolderIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useRequestDraft } from "../../hooks/useRequestDraft";
import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { chefMessageKeyDown } from "../../lib/chefMessageKeyDown";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { agentRequests } from "../../state/agentRequests";
import { useProject, useProjects } from "../../state/entities";
import {
  commandGlobalChef,
  globalChefDossier,
  globalChefDossiers,
  globalChefMemory,
  globalChefStatus,
} from "../../state/globalChef";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { workChantiers } from "../../state/workTasks";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon } from "../ProjectFavicon";
import { RequestCard } from "../agentRequests/AgentRequestsPage";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import {
  MemoryScope,
  memoryActionLabels as actionLabels,
  memoryScopeLabels as scopeLabels,
} from "./MemoryScope";

type Execute = (input: ChefCommand) => Promise<boolean>;
const dossierStates: Record<ChefDossier["state"], string> = {
  pending: "À examiner",
  processing: "En cours d’examen",
  waiting: "En attente",
  done: "Traité",
  error: "À reprendre",
  closed: "Terminé",
};

function DossierProject({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null | undefined;
}) {
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title = project?.title ?? (projectId ? "Projet indisponible" : "Sans projet identifié");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {project ? (
        <ProjectFavicon project={project} className="size-4 shrink-0" />
      ) : (
        <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{title}</span>
    </span>
  );
}

export default function GlobalChefPage({
  environmentId: forcedEnvironmentId,
  dossierId,
}: {
  environmentId?: EnvironmentId | undefined;
  dossierId?: string | undefined;
} = {}) {
  const selection = useEnvironmentSelection();
  const navigate = useNavigate();
  const environmentId = forcedEnvironmentId
    ? (selection.environments.find((v) => v.environmentId === forcedEnvironmentId)?.environmentId ??
      null)
    : selection.environmentId;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <ChefHatIcon className="size-4" />
        <h1 className="text-sm font-medium">Le Chef</h1>
        {selection.environments.length > 1 && (
          <select
            aria-label="Machine du Chef"
            value={environmentId ?? ""}
            onChange={(e) => {
              const selected = selection.environments.find(
                (v) => v.environmentId === e.target.value,
              );
              if (selected)
                void navigate({ to: "/chef", search: { environment: selected.environmentId } });
            }}
          >
            {selection.environments.map((v) => (
              <option key={v.environmentId} value={v.environmentId}>
                {v.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {environmentId ? (
        <ChefWorkspace
          key={environmentId}
          environmentId={environmentId}
          selectedId={dossierId ?? null}
          onSelect={(id) =>
            void navigate({ to: "/chef", search: { environment: environmentId, dossier: id } })
          }
        />
      ) : (
        <p className="p-6">Connecte une machine pour retrouver Le Chef.</p>
      )}
    </SidebarInset>
  );
}

function ChefWorkspace({
  environmentId,
  selectedId,
  onSelect,
}: {
  environmentId: EnvironmentId;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const status = useEnvironmentQuery(globalChefStatus({ environmentId, input: {} }));
  const command = useAtomCommand(commandGlobalChef);
  const allowed = useAtomValue(commandGlobalChef.permissionAtom(environmentId));
  const [view, setView] = useState<"dossiers" | "memory">("dossiers");
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execute: Execute = async (input) => {
    if (!allowed || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return false;
      }
      status.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  const state = status.data;
  const configured = state?.settings.projectId && state.settings.modelSelection;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Button
          variant={view === "dossiers" ? "secondary" : "ghost"}
          onClick={() => setView("dossiers")}
        >
          Dossiers
        </Button>
        <Button
          variant={view === "memory" ? "secondary" : "ghost"}
          onClick={() => setView("memory")}
        >
          <BookOpenIcon className="size-4" />
          Mémoire
        </Button>
        <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">
          {!state
            ? "Chargement…"
            : !configured
              ? "À configurer"
              : !state.settings.enabled
                ? "En pause"
                : `${state.pending} à examiner · ${state.processing} en cours · ${state.waiting} en attente${state.errors ? ` · ${state.errors} à reprendre` : ""}${state.notificationsPending ? ` · ${state.notificationsPending} transmission(s) en attente` : ""}`}
        </p>
        {state && configured && (
          <Button
            variant="outline"
            disabled={!allowed || busy}
            onClick={() =>
              void execute({
                type: "configure",
                ...state.settings,
                enabled: !state.settings.enabled,
              })
            }
          >
            {state.settings.enabled ? (
              <PauseIcon className="size-4" />
            ) : (
              <PlayIcon className="size-4" />
            )}
            {state.settings.enabled ? "Pause" : "Activer"}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setShowSettings((v) => !v)}>
          <SettingsIcon className="size-4" />
          Réglages
        </Button>
      </div>
      {(error || status.error) && (
        <p role="alert" className="p-3 text-destructive">
          {error ?? status.error}
        </p>
      )}
      {state && (showSettings || !configured) && (
        <ChefSettingsForm
          environmentId={environmentId}
          initial={state.settings}
          execute={execute}
          disabled={!allowed || busy}
        />
      )}
      {view === "memory" ? (
        <MemoryView environmentId={environmentId} execute={execute} disabled={!allowed || busy} />
      ) : (
        <DossiersView
          environmentId={environmentId}
          selectedId={selectedId}
          onSelect={onSelect}
          execute={execute}
          disabled={!allowed || busy}
        />
      )}
    </div>
  );
}

function ChefSettingsForm({
  environmentId,
  initial,
  execute,
  disabled,
}: {
  environmentId: EnvironmentId;
  initial: typeof ChefSettings.Type;
  execute: Execute;
  disabled: boolean;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [project, setProject] = useState<string | null>(null);
  const projectId =
    projects.find((p) => p.id === (project ?? initial.projectId))?.id ?? projects[0]?.id ?? null;
  const [draftModel, setDraftModel] = useState<ModelSelection | null>(null);
  const selection = draftModel ?? initial.modelSelection;
  const providers = (config?.providers ?? EMPTY_SERVER_PROVIDERS).filter(
    (p) => p.supportsTextGeneration !== false,
  );
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const picker = selection ?? NO_PROVIDER_MODEL_SELECTION;
  return (
    <form
      className="flex flex-wrap items-end gap-3 border-b bg-muted/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (selection && projectId)
          void execute({ type: "configure", projectId, modelSelection: selection, enabled: true });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Projet d’accueil des dossiers
        <select
          aria-label="Projet d’accueil des dossiers"
          value={projectId ?? ""}
          disabled={disabled}
          onChange={(e) => setProject(e.target.value)}
        >
          {!projects.length && <option value="">Choisir un projet</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={picker.instanceId}
        model={picker.model}
        triggerAriaLabel="Modèle du Chef"
        {...(!selection ? { triggerLabel: "Choisir un modèle" } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        disabled={disabled}
        onInstanceModelChange={(instance, model) =>
          setDraftModel(createModelSelection(instance, model))
        }
      />
      <Button type="submit" disabled={disabled || !selection || !projectId}>
        Enregistrer et activer
      </Button>
    </form>
  );
}

function Pagination({
  previous,
  next,
  onPrevious,
  onNext,
}: {
  previous: boolean;
  next: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex justify-between gap-2 pt-2">
      <Button variant="ghost" size="sm" disabled={!previous} onClick={onPrevious}>
        Précédents
      </Button>
      <Button variant="ghost" size="sm" disabled={!next} onClick={onNext}>
        Suivants
      </Button>
    </div>
  );
}

function DossiersView({
  environmentId,
  selectedId,
  onSelect,
  execute,
  disabled,
}: {
  environmentId: EnvironmentId;
  selectedId: string | null;
  onSelect: (id: string) => void;
  execute: Execute;
  disabled: boolean;
}) {
  const [archive, setArchive] = useState(false);
  const [cursors, setCursors] = useState<ReadonlyArray<number | undefined>>([undefined]);
  const after = cursors.at(-1);
  const query = useEnvironmentQuery(
    globalChefDossiers({
      environmentId,
      input: { ...(after === undefined ? {} : { after }), limit: 20, archived: archive },
    }),
  );
  const requestQuery = useEnvironmentQuery(agentRequests({ environmentId, input: {} }));
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [requestArchive, setRequestArchive] = useState(false);
  const requests = (requestQuery.data ?? []).filter(
    (r) =>
      r.chef &&
      (requestArchive
        ? !["pending", "revision"].includes(r.status)
        : ["pending", "revision"].includes(r.status)),
  );
  const current = requests.find((r) => r.id === selectedRequest) ?? requests[0];
  const id = selectedId ?? query.data?.dossiers[0]?.id;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-[minmax(0,1.6fr)_minmax(22rem,1fr)] xl:overflow-hidden">
      <section
        aria-label="Dossiers du Chef"
        className="flex min-h-128 min-w-0 flex-col border-b sm:flex-row xl:min-h-0 xl:border-r xl:border-b-0"
      >
        <aside className="flex max-h-48 w-full shrink-0 flex-col gap-2 overflow-y-auto border-b p-3 sm:max-h-none sm:w-52 sm:border-r sm:border-b-0">
          <Button
            variant={archive ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setArchive((v) => !v);
              setCursors([undefined]);
            }}
          >
            Archives des dossiers
          </Button>
          {query.data?.dossiers.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelect(d.id)}
              aria-pressed={id === d.id}
              className={cn(
                "rounded-2xl border p-3 text-left text-sm hover:bg-muted",
                id === d.id && "bg-muted",
              )}
            >
              <span className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                <DossierProject environmentId={environmentId} projectId={d.projectId} />
                <span>· {dossierStates[d.state]}</span>
              </span>
              <span className="line-clamp-3 font-medium">{d.title}</span>
            </button>
          ))}
          {query.error && <p role="alert">{query.error}</p>}
          {query.data?.dossiers.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">Aucun dossier dans cette liste.</p>
          )}
          <Pagination
            previous={cursors.length > 1}
            next={query.data?.nextCursor != null && !query.isPending}
            onPrevious={() => setCursors((v) => v.slice(0, -1))}
            onNext={() => {
              const next = query.data?.nextCursor;
              if (next != null) setCursors((v) => [...v, next]);
            }}
          />
        </aside>
        {id ? (
          <DossierConversation
            key={id}
            id={id}
            environmentId={environmentId}
            execute={execute}
            disabled={disabled}
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            Les sujets prêts de Luna apparaîtront ici quand le Chef sera activé.
          </p>
        )}
      </section>
      <section
        aria-label="Requêtes du Chef"
        className="min-h-96 min-w-0 overflow-y-auto p-4 xl:min-h-0"
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="flex-1 font-medium">Requêtes</h2>
          <Button
            variant={requestArchive ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setRequestArchive((v) => !v)}
          >
            Traitées
          </Button>
        </div>
        {requests.length > 0 && (
          <select
            aria-label="Requête du Chef"
            value={current?.id ?? ""}
            className="mb-5 w-full"
            onChange={(e) => setSelectedRequest(e.target.value)}
          >
            {requests.map((r) => (
              <option key={r.id} value={r.id}>
                {r.question}
              </option>
            ))}
          </select>
        )}
        {current ? (
          <RequestCard
            key={`${current.id}:${current.version}`}
            request={current}
            environmentId={environmentId}
            inline
            onOpenDossier={onSelect}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {requestQuery.error ?? "Aucune décision en attente dans cette liste."}
          </p>
        )}
      </section>
    </div>
  );
}

function DossierConversation({
  environmentId,
  id,
  execute,
  disabled,
}: {
  environmentId: EnvironmentId;
  id: string;
  execute: Execute;
  disabled: boolean;
}) {
  const [before, setBefore] = useState<number | undefined>();
  const query = useEnvironmentQuery(
    globalChefDossier({
      environmentId,
      input: { id, ...(before === undefined ? {} : { before }) },
    }),
  );
  const { text, setText, clearSubmitted } = useRequestDraft(
    environmentId,
    { id: `dossier:${id}`, version: 0 },
    "temporaryDrafts",
  );
  const pending = useRef<{ id: string; text: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latest = query.data?.messages.at(-1)?.id;
  useEffect(() => {
    if (latest && before === undefined && follow.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [latest, before]);
  const d = query.data?.dossier;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            <DossierProject environmentId={environmentId} projectId={d?.projectId} />
          </p>
          <h2 className="truncate font-medium">{d?.title ?? "Chargement…"}</h2>
        </div>
        {d && <Badge variant="secondary">{dossierStates[d.state]}</Badge>}
        {d?.state === "error" && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void execute({ type: "retry", id }).then((ok) => {
                if (ok) query.refresh();
              })
            }
          >
            Réessayer
          </Button>
        )}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4"
        onScroll={(e) => {
          const node = e.currentTarget;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {before !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => setBefore(undefined)}>
            Derniers messages
          </Button>
        )}
        {query.data?.nextCursor != null && (
          <Button variant="ghost" size="sm" onClick={() => setBefore(query.data!.nextCursor!)}>
            Messages précédents
          </Button>
        )}
        {query.data?.messages.map((m) => (
          <article
            key={m.id}
            className={cn("mb-3 rounded-2xl border p-4", m.role === "user" && "bg-muted/40")}
          >
            <p className="mb-2 text-xs text-muted-foreground">
              {m.role === "user"
                ? "Valentin"
                : m.role === "chef"
                  ? "Chef responsable"
                  : m.role === "event"
                    ? "Suivi"
                    : "Le Chef"}
            </p>
            <ChatMarkdown
              text={m.text}
              environmentId={environmentId}
              threadRef={{ environmentId, threadId: query.data!.dossier.threadId }}
              cwd={undefined}
            />
          </article>
        ))}
        {(query.error || d?.error) && (
          <p role="alert" className="text-sm text-destructive">
            {query.error ?? d?.error}
          </p>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="flex items-end gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || !d || d.state === "closed" || !text.trim()) return;
          if (!pending.current || pending.current.text !== text)
            pending.current = { id: randomUUID(), text };
          void execute({ type: "message", id, messageId: pending.current.id, text }).then((ok) => {
            if (ok) {
              clearSubmitted();
              pending.current = null;
              setBefore(undefined);
              follow.current = true;
              query.refresh();
            }
          });
        }}
      >
        <Textarea
          aria-label="Message au Chef"
          placeholder="En discuter avec Le Chef…"
          maxLength={10_000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => chefMessageKeyDown(e, setText)}
          disabled={disabled || d?.state === "closed"}
        />
        <Button type="submit" disabled={disabled || !d || !text.trim() || d.state === "closed"}>
          <SendIcon className="size-4" />
          <span className="sr-only">Envoyer au Chef</span>
        </Button>
      </form>
    </div>
  );
}

function MemoryView({
  environmentId,
  execute,
  disabled,
}: {
  environmentId: EnvironmentId;
  execute: Execute;
  disabled: boolean;
}) {
  const [cursors, setCursors] = useState<ReadonlyArray<number | undefined>>([undefined]);
  const [editing, setEditing] = useState<ChefMemory | null>(null);
  const after = cursors.at(-1);
  const query = useEnvironmentQuery(
    globalChefMemory({
      environmentId,
      input: { ...(after === undefined ? {} : { after }), limit: 20 },
    }),
  );
  return (
    <section
      aria-label="Mémoire du Chef"
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto p-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Mémoire approuvée</h2>
          <p className="text-sm text-muted-foreground">Chaque phrase reste sous ton contrôle.</p>
        </div>
        {editing && (
          <MemoryEditor
            key={editing.id}
            initial={editing}
            environmentId={environmentId}
            disabled={disabled}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              if (await execute(input)) {
                setEditing(null);
                query.refresh();
              }
            }}
          />
        )}
        {query.data?.memories.map((m) => (
          <article key={m.id} className="rounded-2xl border p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Badge variant="secondary">
                {m.kind === "rule" ? "Règle" : "Fait"} · {m.enabled ? "Actif" : "Désactivé"}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => setEditing(m)} disabled={disabled}>
                Modifier
              </Button>
            </div>
            <p className="whitespace-pre-wrap">{m.text}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              <MemoryScope scope={m.scope} environmentId={environmentId} /> · {m.topic}
              {m.action ? ` · ${actionLabels[m.action]}` : ""}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void execute({
                  type: "memory",
                  ...m,
                  expectedVersion: m.version,
                  enabled: !m.enabled,
                }).then((ok) => {
                  if (ok) query.refresh();
                })
              }
            >
              {m.enabled ? "Désactiver" : "Réactiver"}
            </Button>
          </article>
        ))}
        {query.data?.memories.length === 0 && (
          <p className="py-10 text-center text-muted-foreground">
            Aucune phrase mémorisée. Une action ponctuelle n’ajoute rien ici.
          </p>
        )}
        {query.error && <p role="alert">{query.error}</p>}
        <Pagination
          previous={cursors.length > 1}
          next={query.data?.nextCursor != null && !query.isPending}
          onPrevious={() => setCursors((v) => v.slice(0, -1))}
          onNext={() => {
            const next = query.data?.nextCursor;
            if (next != null) setCursors((v) => [...v, next]);
          }}
        />
      </div>
    </section>
  );
}

function MemoryEditor({
  initial,
  environmentId,
  onSave,
  onCancel,
  disabled,
}: {
  initial: ChefMemory;
  environmentId: EnvironmentId;
  onSave: (input: Extract<ChefCommand, { type: "memory" }>) => Promise<void>;
  onCancel: () => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const chantiers = useEnvironmentQuery(workChantiers({ environmentId, input: {} }));
  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border bg-muted/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ type: "memory", ...draft, expectedVersion: initial.version });
      }}
    >
      <label className="text-sm">
        Phrase exacte
        <Textarea
          aria-label="Phrase mémorisée"
          value={draft.text}
          maxLength={500}
          onChange={(e) => setDraft((v) => ({ ...v, text: e.target.value }))}
        />
      </label>
      <label className="text-sm">
        Type de sujets
        <Input
          value={draft.topic}
          maxLength={500}
          onChange={(e) => setDraft((v) => ({ ...v, topic: e.target.value }))}
        />
      </label>
      {draft.kind === "rule" && (
        <label className="text-sm">
          Action autorisée
          <select
            value={draft.action ?? "create"}
            onChange={(e) =>
              setDraft((v) => ({
                ...v,
                action: e.target.value as NonNullable<ChefMemory["action"]>,
              }))
            }
          >
            {Object.entries(actionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="text-sm">
        Portée
        <select
          value={draft.scope.kind}
          onChange={(e) => {
            const kind = e.target.value as ChefMemory["scope"]["kind"];
            setDraft((v) => ({ ...v, scope: { kind, id: null } }));
          }}
        >
          {Object.entries(scopeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {draft.scope.kind === "project" && (
        <select
          aria-label="Projet de la mémoire"
          value={draft.scope.id ?? ""}
          onChange={(e) =>
            setDraft((v) => ({ ...v, scope: { kind: "project", id: e.target.value } }))
          }
        >
          <option value="">Choisir un projet</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      )}
      {draft.scope.kind === "chantier" && (
        <select
          aria-label="Chantier de la mémoire"
          value={draft.scope.id ?? ""}
          onChange={(e) =>
            setDraft((v) => ({ ...v, scope: { kind: "chantier", id: e.target.value } }))
          }
        >
          <option value="">Choisir un chantier</option>
          {chantiers.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      )}
      {draft.scope.kind === "sender" &&
        (draft.scope.id?.startsWith("slack:") ? (
          <p className="text-sm text-muted-foreground">Contact Slack de la décision d’origine.</p>
        ) : (
          <label className="text-sm">
            Adresse e-mail de l’expéditeur
            <Input
              type="email"
              aria-label="Expéditeur de la mémoire"
              value={draft.scope.id?.replace(/^gmail:/, "") ?? ""}
              onChange={(e) =>
                setDraft((v) => ({
                  ...v,
                  scope: {
                    kind: "sender",
                    id: e.target.value.trim()
                      ? `gmail:${e.target.value.trim().toLowerCase()}`
                      : null,
                  },
                }))
              }
            />
          </label>
        ))}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            disabled ||
            !draft.text.trim() ||
            !draft.topic.trim() ||
            (draft.scope.kind !== "global" && !draft.scope.id)
          }
        >
          Enregistrer cette phrase
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
