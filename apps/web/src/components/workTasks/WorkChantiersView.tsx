import { BotIcon, ListTodoIcon, GitBranchIcon, FileTextIcon } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ProjectId,
  type EnvironmentId,
  type WorkChantier,
  type WorkChantierSaveInput,
  type WorkTask,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { randomUUID } from "../../lib/utils";
import {
  workChantiers,
  workTasks,
  saveWorkChantier,
  launchWorkChantier,
} from "../../state/workTasks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { ProjectFavicon } from "../ProjectFavicon";
import { WorkSourceEditor } from "./WorkSourceEditor";
import { WorkDependencyTree } from "./WorkDependencyTree";
import type { Project } from "../../types";

const ChatView = lazy(() => import("../ChatView"));
const STATUS = {
  draft: "Brouillon",
  active: "En cours",
  paused: "En pause",
  done: "Terminé",
} as const;
const VIEW_ICONS = {
  discussion: BotIcon,
  tasks: ListTodoIcon,
  tree: GitBranchIcon,
  context: FileTextIcon,
};
const VIEWS = {
  discussion: "Orchestrateur",
  tasks: "Tâches",
  tree: "Arbre",
  context: "Contexte",
} as const;

export function WorkChantiersView({
  environmentId,
  renderTasks,
}: {
  environmentId: EnvironmentId;
  renderTasks: (chantierId: string) => ReactNode;
}) {
  const search = useSearch({ from: "/_chat/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const query = useEnvironmentQuery(workChantiers({ environmentId, input: {} }));
  const taskQuery = useEnvironmentQuery(workTasks({ environmentId, input: {} }));
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const { environments } = useEnvironments();
  const providers =
    environments.find((e) => e.environmentId === environmentId)?.serverConfig?.providers ??
    EMPTY_SERVER_PROVIDERS;
  const save = useAtomCommand(saveWorkChantier);
  const launch = useAtomCommand(launchWorkChantier);
  const canSave = useAtomValue(saveWorkChantier.permissionAtom(environmentId));
  const canLaunch = useAtomValue(launchWorkChantier.permissionAtom(environmentId));
  const [draft, setDraft] = useState<WorkChantierSaveInput | null>(null);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chantier = query.data?.find((c) => c.id === search.chantier);
  const tasks = (taskQuery.data ?? []).filter((t) => t.chantierId === chantier?.id);
  const view = search.view ?? "discussion";
  const open = (id?: string, nextView: keyof typeof VIEWS = "discussion", task?: string) =>
    navigate({
      search: { tab: "chantiers", chantier: id, view: nextView, task, environment: environmentId },
    });
  const launchDiscussion = async (item: WorkChantier) => {
    const project = projects.find((p) => p.id === item.projectId);
    if (!project) {
      setError("Le projet du chantier est indisponible.");
      return;
    }
    const defaultModelSelection = resolveDefaultProviderModelSelection(
      providers,
      resolveProjectSettings(settings, item.projectId, project).settings.defaultModelSelection,
    );
    if (!defaultModelSelection) {
      setError("Configure un fournisseur et un modèle pour ce projet.");
      return;
    }
    const modelSelection =
      defaultModelSelection.model === "gpt-6-astra"
        ? {
            ...defaultModelSelection,
            model: "gpt-6.1-sol",
            options: [
              ...(defaultModelSelection.options ?? []).filter(
                (option) => option.id !== "reasoningEffort",
              ),
              { id: "reasoningEffort", value: "xhigh" },
            ],
          }
        : defaultModelSelection;
    setBusy(true);
    setError(null);
    try {
      const result = await launch({
        environmentId,
        input: { id: item.id, expectedVersion: item.version, modelSelection },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else await open(item.id);
    } finally {
      setBusy(false);
    }
  };
  const persist = async (input: WorkChantierSaveInput, start: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await save({ environmentId, input });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return;
      }
      setDraft(null);
      await open(result.value.id, start ? "discussion" : "context");
      if (start) await launchDiscussion(result.value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 space-y-5">
      {(error || query.error || taskQuery.error) && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error ?? String(query.error ?? taskQuery.error)}
        </p>
      )}
      {draft ? (
        <ChantierForm
          key={draft.id}
          initial={draft}
          projects={projects}
          busy={busy}
          canSave={canSave}
          canLaunch={canLaunch}
          onSave={persist}
          onCancel={() => setDraft(null)}
          currentVersion={query.data?.find((c) => c.id === draft.id)?.version ?? 0}
        />
      ) : chantier ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <button
                className="mb-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => void open()}
              >
                ← Tous les chantiers
              </button>
              <h2 className="text-xl font-semibold">{chantier.title}</h2>
            </div>
            <Button
              variant="outline"
              disabled={!canSave}
              onClick={() => setDraft({ ...chantier, expectedVersion: chantier.version })}
            >
              Modifier le contexte
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 border-b pb-3" aria-label="Vues du chantier">
            {Object.entries(VIEWS).map(([id, label]) => {
              const Icon = VIEW_ICONS[id as keyof typeof VIEWS];
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={view === id ? "secondary" : "ghost"}
                  onClick={() => void open(chantier.id, id as keyof typeof VIEWS)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Button>
              );
            })}
          </div>
          {view === "discussion" &&
            (chantier.orchestratorThreadId ? (
              <ChantierDiscussion environmentId={environmentId} chantier={chantier} tasks={tasks} />
            ) : (
              <div className="space-y-4 rounded-xl border p-6">
                <h3 className="font-medium">Orchestrateur du chantier</h3>
                <p className="text-sm text-muted-foreground">
                  Une discussion permanente pour cadrer, découper et suivre ce chantier. Son
                  lancement ne démarre aucune tâche d’exécution.
                </p>
                <Button
                  disabled={busy || !canLaunch}
                  onClick={() => void launchDiscussion(chantier)}
                >
                  Ouvrir la discussion avec l’orchestrateur
                </Button>
              </div>
            ))}
          {view === "tasks" && renderTasks(chantier.id)}
          {view === "tree" && (
            <WorkDependencyTree
              chantier={chantier}
              tasks={tasks}
              onOpenTask={(id) => void open(chantier.id, "tasks", id)}
              onDiscuss={() => void open(chantier.id)}
            />
          )}
          {view === "context" && (
            <div className="grid gap-4 md:grid-cols-2">
              {[
                ["Objectif", chantier.objective],
                ["Périmètre et responsabilités", chantier.scope],
                ["Décisions et questions ouvertes", chantier.decisions],
              ].map(([title, text]) => (
                <section key={title} className="space-y-2 rounded-xl border bg-card p-5">
                  <h3 className="font-medium">{title}</h3>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {text || "À préciser avec l’orchestrateur."}
                  </p>
                </section>
              ))}
              <section className="space-y-3 rounded-xl border bg-card p-5">
                <h3 className="font-medium">Sources</h3>
                {chantier.sources.map((source, i) => (
                  <p key={i} className="text-sm">
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {source.label}
                      </a>
                    ) : (
                      source.label
                    )}
                  </p>
                ))}
                {!chantier.sources.length && (
                  <p className="text-sm text-muted-foreground">Aucune source ajoutée.</p>
                )}
                <h3 className="font-medium">Attentes externes</h3>
                {chantier.externalDependencies.map((e) => (
                  <p key={e.id} className="text-sm">
                    {e.done ? "✓" : "◷"} {e.title} · {e.owner || "Responsable à préciser"}
                  </p>
                ))}
              </section>
            </div>
          )}
        </>
      ) : search.chantier ? (
        <p>
          {query.data ? "Ce chantier est indisponible sur cette machine." : "Chargement…"}{" "}
          <button className="text-primary" onClick={() => void open()}>
            Retour aux chantiers
          </button>
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Les chantiers</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Un objectif, ses tâches et une discussion pour le piloter.
              </p>
            </div>
            <Button
              disabled={!canSave || !projects.length}
              onClick={() =>
                setDraft({
                  id: randomUUID(),
                  expectedVersion: 0,
                  title: "",
                  projectId: projects[0]!.id,
                  status: "draft",
                  objective: "",
                  scope: "",
                  decisions: "",
                  targetPeriod: "",
                  sources: [],
                  externalDependencies: [],
                })
              }
            >
              Nouveau chantier
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              aria-label="Rechercher un chantier"
              placeholder="Rechercher un chantier…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              aria-label="Projet des chantiers"
              className="rounded-lg border bg-background p-2 text-sm"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="">Tous les projets</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <select
              aria-label="État des chantiers"
              className="rounded-lg border bg-background p-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Tous les états</option>
              {Object.entries(STATUS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="divide-y rounded-xl border bg-card">
            {(query.data ?? [])
              .filter(
                (c) =>
                  (!projectFilter || c.projectId === projectFilter) &&
                  (!statusFilter || c.status === statusFilter) &&
                  `${c.title} ${c.objective}`
                    .toLocaleLowerCase()
                    .includes(filter.toLocaleLowerCase()),
              )
              .map((c) => {
                const project = projects.find((p) => p.id === c.projectId);
                const items = (taskQuery.data ?? []).filter((t) => t.chantierId === c.id);
                return (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
                    <div className="min-w-0 space-y-2">
                      <button
                        onClick={() => void open(c.id)}
                        className="flex items-center gap-2 text-left font-medium hover:underline"
                      >
                        {project && <ProjectFavicon project={project} className="size-4" />}
                        {c.title}
                      </button>
                      <p className="text-sm text-muted-foreground">
                        {project?.title ?? "Projet indisponible"} ·{" "}
                        {c.targetPeriod || "Sans période cible"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {items.length} tâches · {items.filter((t) => t.status === "done").length}{" "}
                        terminées · {c.externalDependencies.filter((e) => !e.done).length} attentes
                        externes
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary">{STATUS[c.status]}</Badge>
                      <Button size="sm" variant="outline" onClick={() => void open(c.id)}>
                        Orchestrateur
                      </Button>
                    </div>
                  </div>
                );
              })}
            {!query.data?.length && (
              <p className="p-6 text-sm text-muted-foreground">
                {query.data
                  ? "Aucun chantier. Crée un chantier pour préparer un lot avec son orchestrateur."
                  : "Chargement…"}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ChantierDiscussion({
  environmentId,
  chantier,
  tasks,
}: {
  environmentId: EnvironmentId;
  chantier: WorkChantier;
  tasks: ReadonlyArray<WorkTask>;
}) {
  const thread = useThreadShell(
    chantier.orchestratorThreadId
      ? scopeThreadRef(environmentId, chantier.orchestratorThreadId)
      : null,
  );
  return (
    <div className="flex h-[calc(100dvh-260px)] min-h-[460px] min-w-0 gap-4">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between gap-2 border-b p-3 text-sm">
          <span>Orchestrateur · discussion globale</span>
          {chantier.orchestratorThreadId && (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: chantier.orchestratorThreadId }}
              className="text-primary hover:underline"
            >
              Plein écran
            </Link>
          )}
        </div>
        {thread && !thread.deletedAt && chantier.orchestratorThreadId ? (
          <div className="relative flex min-h-0 min-w-0 flex-1 [transform:translate(0)]">
            <Suspense fallback={<p className="p-4">Chargement de la discussion…</p>}>
              <ChatView
                environmentId={environmentId}
                threadId={chantier.orchestratorThreadId}
                routeKind="server"
                reserveTitleBarControlInset={false}
              />
            </Suspense>
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Discussion en cours de chargement ou indisponible. Le contexte du chantier reste
            accessible.
          </p>
        )}
      </div>
      <aside className="hidden w-60 shrink-0 space-y-5 overflow-y-auto rounded-xl border bg-card p-4 xl:block">
        <h3 className="font-medium">Contexte du chantier</h3>
        <p className="whitespace-pre-wrap text-sm">{chantier.objective || "Objectif à préciser"}</p>
        <p className="text-sm">
          {tasks.filter((t) => t.status === "done").length}/{tasks.length} tâches terminées
        </p>
        <h3 className="text-sm font-medium">Sources</h3>
        {chantier.sources.map((s, i) => (
          <p key={i} className="text-sm text-muted-foreground">
            {s.label}
          </p>
        ))}
        <h3 className="text-sm font-medium">Décisions</h3>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {chantier.decisions || "Aucune décision enregistrée."}
        </p>
      </aside>
    </div>
  );
}

function ChantierForm({
  initial,
  projects,
  busy,
  canSave,
  canLaunch,
  currentVersion,
  onSave,
  onCancel,
}: {
  initial: WorkChantierSaveInput;
  projects: ReadonlyArray<Project>;
  busy: boolean;
  canSave: boolean;
  canLaunch: boolean;
  currentVersion: number;
  onSave: (input: WorkChantierSaveInput, start: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const stale = currentVersion !== initial.expectedVersion;
  return (
    <form
      className="space-y-5 rounded-xl border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft, draft.expectedVersion === 0 && canLaunch);
      }}
    >
      <h2 className="text-xl font-semibold">
        {initial.expectedVersion ? "Contexte du chantier" : "Nouveau chantier"}
      </h2>
      <fieldset disabled={busy || !canSave || stale} className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span>Nom du chantier</span>
          <Input
            autoFocus
            required
            maxLength={240}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span>Projet</span>
            <select
              aria-label="Projet du chantier"
              className="w-full rounded-lg border bg-background p-2"
              value={draft.projectId}
              onChange={(e) => setDraft({ ...draft, projectId: ProjectId.make(e.target.value) })}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Période cible</span>
            <Input
              placeholder="Novembre"
              maxLength={240}
              value={draft.targetPeriod}
              onChange={(e) => setDraft({ ...draft, targetPeriod: e.target.value })}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span>État</span>
            <select
              className="w-full rounded-lg border bg-background p-2"
              value={draft.status}
              onChange={(e) =>
                setDraft({ ...draft, status: e.target.value as WorkChantier["status"] })
              }
            >
              {Object.entries(STATUS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(
          [
            ["objective", "Résultat attendu", 10000],
            ["scope", "Périmètre et responsabilités", 20000],
            ["decisions", "Décisions et questions ouvertes", 20000],
          ] as const
        ).map(([key, label, max]) => (
          <label key={key} className="block space-y-1 text-sm">
            <span>{label}</span>
            <Textarea
              maxLength={max}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <WorkSourceEditor
          sources={draft.sources}
          onChange={(sources) => setDraft({ ...draft, sources })}
        />
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Attentes externes</legend>
          {draft.externalDependencies.map((item, index) => (
            <div key={item.id} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
              <Input
                aria-label={`Attente externe ${index + 1}`}
                required
                maxLength={240}
                placeholder="Contrat promotions"
                value={item.title}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    externalDependencies: draft.externalDependencies.map((d) =>
                      d.id === item.id ? { ...d, title: e.target.value } : d,
                    ),
                  })
                }
              />
              <Input
                aria-label={`Responsable ${index + 1}`}
                maxLength={240}
                placeholder="Équipe produits"
                value={item.owner}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    externalDependencies: draft.externalDependencies.map((d) =>
                      d.id === item.id ? { ...d, owner: e.target.value } : d,
                    ),
                  })
                }
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      externalDependencies: draft.externalDependencies.map((d) =>
                        d.id === item.id ? { ...d, done: e.target.checked } : d,
                      ),
                    })
                  }
                />
                Livré
              </label>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    externalDependencies: draft.externalDependencies.filter(
                      (d) => d.id !== item.id,
                    ),
                  })
                }
              >
                Retirer
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={draft.externalDependencies.length >= 100}
            onClick={() =>
              setDraft({
                ...draft,
                externalDependencies: [
                  ...draft.externalDependencies,
                  { id: randomUUID(), title: "", owner: "", done: false },
                ],
              })
            }
          >
            Ajouter une attente externe
          </Button>
        </fieldset>
      </fieldset>
      {stale && (
        <p role="alert" className="text-sm text-destructive-foreground">
          Le chantier a changé. Ferme puis rouvre le formulaire pour récupérer la dernière version.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !canSave || stale}>
          {initial.expectedVersion
            ? "Enregistrer le contexte"
            : canLaunch
              ? "Créer et ouvrir la discussion"
              : "Créer le chantier"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
