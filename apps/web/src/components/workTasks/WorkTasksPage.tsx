import { TaskSelect, TaskField } from "./TaskFormFields";
import { TaskDescription } from "./TaskDescription";
import { useStore } from "zustand";
import { taskPageState, type WorkTaskDraft } from "../../state/workPageState";
import { STATUS_LABELS, STATUS_PRESENTATION } from "./workTaskPresentation";
import { WorkChantiersView } from "./WorkChantiersView";
import { WorkSourceEditor } from "./WorkSourceEditor";
import { workTaskBlockers, workTaskSources } from "@t3tools/contracts";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import {
  ProjectId,
  isClosedWorkTaskStatus,
  type EnvironmentId,
  type WorkTask,
  type WorkTaskTypesConfig,
  type WorkTaskSaveInput,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ListTodoIcon, PlusIcon, BotIcon } from "lucide-react";
import { useState, useEffect, useRef, type CSSProperties } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useWorkPageEnvironmentSelection } from "../../hooks/useWorkPageEnvironmentSelection";
import { useEnvironmentQuery } from "../../state/query";
import {
  workTasks,
  workChantiers,
  saveWorkTask,
  deleteWorkTask,
  workTaskMessages,
  workTaskTypes,
  saveWorkTaskTypes,
  launchWorkTask,
} from "../../state/workTasks";
import { useAtomCommand } from "../../state/use-atom-command";
import { isElectron } from "../../env";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { ProjectFavicon } from "../ProjectFavicon";
import { useUiStateStore } from "../../uiStateStore";
import type { Project } from "../../types";
import { deriveProjectIdentity } from "../../projectIdentity";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";

function ProjectOption({ project }: { project: Project }) {
  const color = project.projectIcon?.color ?? deriveProjectIdentity(project.title).color;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ProjectFavicon project={project} className="size-4 shrink-0" />
      <span className="truncate">{project.title}</span>
      <span
        aria-hidden="true"
        className={`ml-auto size-2 shrink-0 rounded-full ${PROJECT_ICON_COLORS.find((entry) => entry.value === color)?.swatchClassName ?? ""}`}
      />
    </span>
  );
}

function TaskProjectSelect({
  projects,
  value,
  onValueChange,
  emptyLabel,
  label,
}: {
  projects: readonly Project[];
  value: string;
  onValueChange: (value: string) => void;
  emptyLabel: string;
  label: string;
}) {
  const selected = projects.find((project) => project.id === value);
  const fallbackLabel = value ? "Projet masqué ou indisponible" : emptyLabel;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>{selected ? <ProjectOption project={selected} /> : fallbackLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value="">{emptyLabel}</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id} label={project.title}>
            <ProjectOption project={project} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const FILTERS = [
  { id: "all", label: "Tout" },
  { id: "ready", label: "À démarrer" },
  { id: "mine", label: "Pour moi" },
  { id: "agents", label: "Agents" },
  { id: "review", label: "À valider" },
  { id: "done", label: "Terminées" },
  { id: "rejected", label: "Refusées" },
  { id: "merged", label: "Fusionnées" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

export function WorkTasksPage() {
  const search = useSearch({ from: "/_chat/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const {
    environments,
    isReady,
    environmentId: selectedEnvironmentId,
    setEnvironmentId,
  } = useWorkPageEnvironmentSelection("tasks");
  const environmentId = search.environment
    ? (environments.find((e) => e.environmentId === search.environment)?.environmentId ?? null)
    : selectedEnvironmentId;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <ListTodoIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Tâches</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="expanded" className="max-w-none">
          <div
            className="grid grid-cols-2 gap-1 rounded-xl bg-foreground/3 p-1 text-center"
            aria-label="Sections des tâches"
          >
            <Link
              to="/tasks"
              search={{ tab: "tasks", environment: environmentId ?? undefined }}
              className={
                search.tab !== "chantiers"
                  ? "rounded-lg bg-primary/8 px-3 py-2 text-sm font-medium text-primary"
                  : "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-foreground/4"
              }
            >
              Tâches
            </Link>
            <Link
              to="/tasks"
              search={{ tab: "chantiers", environment: environmentId ?? undefined }}
              className={
                search.tab === "chantiers"
                  ? "rounded-lg bg-primary/8 px-3 py-2 text-sm font-medium text-primary"
                  : "rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-foreground/4"
              }
            >
              Chantiers
            </Link>
          </div>
          {environments.length > 1 && (
            <TaskField label="Machine">
              <TaskSelect
                value={environmentId ?? ""}
                onChange={(event) => {
                  void navigate({
                    search: { tab: search.tab ?? "tasks", environment: event.target.value },
                  });
                  setEnvironmentId(
                    environments.find((entry) => entry.environmentId === event.target.value)
                      ?.environmentId ?? null,
                  );
                }}
              >
                {environments.map((entry) => (
                  <option key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </option>
                ))}
              </TaskSelect>
            </TaskField>
          )}
          {environmentId ? (
            search.tab === "chantiers" ? (
              <WorkChantiersView
                key={environmentId}
                environmentId={environmentId}
                renderTasks={(id) => (
                  <EnvironmentTasks key={id} environmentId={environmentId} chantierId={id} />
                )}
              />
            ) : (
              <EnvironmentTasks key={environmentId} environmentId={environmentId} />
            )
          ) : (
            <p>
              {isReady
                ? "Aucun serveur enregistré dans les connexions de Travail."
                : "Chargement des connexions…"}
            </p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function EnvironmentTasks({
  environmentId,
  chantierId,
}: {
  environmentId: EnvironmentId;
  chantierId?: string;
}) {
  const searchParams = useSearch({ from: "/_chat/tasks" });
  const chantierQuery = useEnvironmentQuery(workChantiers({ environmentId, input: {} }));
  const chantiers = chantierQuery.data ?? [];
  const chantier = chantiers.find((c) => c.id === chantierId);
  const settings = useEnvironmentSettings(environmentId);
  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? EMPTY_SERVER_PROVIDERS;
  const typesQuery = useEnvironmentQuery(workTaskTypes({ environmentId, input: {} }));
  const saveTypes = useAtomCommand(saveWorkTaskTypes);
  const launch = useAtomCommand(launchWorkTask);
  const canLaunch = useAtomValue(launchWorkTask.permissionAtom(environmentId));
  const canConfigure = useAtomValue(saveWorkTaskTypes.permissionAtom(environmentId));
  const [typesDraft, setTypesDraft] = useState<WorkTaskTypesConfig | null>(null);
  const query = useEnvironmentQuery(workTasks({ environmentId, input: {} }));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const hiddenProjectKeys = useUiStateStore((store) => store.sidebarHiddenProjectKeys);
  const selectableProjects = projects.filter(
    (project) => !hiddenProjectKeys.includes(`${project.environmentId}:${project.id}`),
  );
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.deletedAt === null,
  );
  const canSave = useAtomValue(saveWorkTask.permissionAtom(environmentId));
  const canDelete = useAtomValue(deleteWorkTask.permissionAtom(environmentId));
  const save = useAtomCommand(saveWorkTask);
  const remove = useAtomCommand(deleteWorkTask);
  const page = taskPageState(
    chantierId ? JSON.stringify([environmentId, chantierId]) : environmentId,
  );
  const { filter, search, projectFilter, editing } = useStore(page);
  const setFilter = (filter: Filter) => page.setState({ filter });
  const setSearch = (search: string) => page.setState({ search });
  const setProjectFilter = (projectFilter: string) => page.setState({ projectFilter });
  const setEditing = (editing: WorkTaskDraft | null) => page.setState({ editing });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tasks = query.data ?? [];
  const visible = tasks
    .filter((task) => {
      if ((task.chantierId ?? null) !== (chantierId ?? null)) return false;
      if (projectFilter && task.projectId !== projectFilter) return false;
      if (
        search &&
        !`${task.title} ${task.notes}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      )
        return false;
      switch (filter) {
        case "ready":
          return task.status === filter;
        case "mine":
          return task.agentThreadId === null && !isClosedWorkTaskStatus(task.status);
        case "agents":
          return task.agentThreadId !== null && !isClosedWorkTaskStatus(task.status);
        case "review":
          return task.status === "review";
        case "done":
          return task.status === "done";
        case "rejected":
        case "merged":
          return task.status === filter;
        default:
          return !isClosedWorkTaskStatus(task.status);
      }
    })
    .sort((a, b) => STATUS_PRESENTATION[a.status].rank - STATUS_PRESENTATION[b.status].rank);
  const beginEdit = (task?: WorkTask) => {
    setError(null);
    setConfirmDelete(false);
    setEditing(
      task
        ? { ...task, expectedVersion: task.version }
        : {
            id: randomUUID(),
            expectedVersion: 0,
            title: "",
            notes: "",
            status: "ready",
            automationMode: "manual",
            chantierId: chantierId ?? null,
            projectId:
              chantier?.projectId ?? (projectFilter ? ProjectId.make(projectFilter) : null),
            agentThreadId: null,
            dueDate: null,
          },
    );
  };
  const openedTask = useRef<string | null>(null);
  useEffect(() => {
    if (!searchParams.task) {
      openedTask.current = null;
      return;
    }
    if (openedTask.current === searchParams.task) return;
    const task = tasks.find(
      (t) => t.id === searchParams.task && (!chantierId || t.chantierId === chantierId),
    );
    if (task) {
      openedTask.current = task.id;
      if (editing?.id !== task.id)
        page.setState({ editing: { ...task, expectedVersion: task.version } });
    }
  }, [searchParams.task, tasks, chantierId, editing?.id, page]);
  const persist = async (input: WorkTaskSaveInput, closeEditor: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await save({ environmentId, input });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return;
      }
      if (closeEditor) setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  const deleteTask = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await remove({
        environmentId,
        input: { id: editing.id, expectedVersion: editing.expectedVersion },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  const availableThreads = threads.filter(
    (thread) => editing?.projectId === null || thread.projectId === editing?.projectId,
  );
  const editorIsStale =
    editing !== null &&
    editing.expectedVersion > 0 &&
    query.data !== null &&
    tasks.find((task) => task.id === editing.id)?.version !== editing.expectedVersion;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {chantierId ? "Tâches du chantier" : "Les choses à faire"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tes tâches et celles confiées aux agents, au même endroit.
          </p>
        </div>
        <Button disabled={!canSave || busy} onClick={() => beginEdit()}>
          <PlusIcon />
          Nouvelle tâche
        </Button>
      </div>
      <Button
        variant="outline"
        disabled={!canConfigure || !typesQuery.data || busy}
        onClick={() => setTypesDraft(typesQuery.data)}
      >
        Configurer les types
      </Button>
      {typesDraft && (
        <form
          className="space-y-3 rounded-xl border p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await saveTypes({ environmentId, input: typesDraft });
              if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
              else setTypesDraft(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3>Types de tâche · prompts des agents</h3>
          <p className="text-sm text-muted-foreground">
            Aucun : lance l’agent avec le titre, les notes et les messages de la tâche.
          </p>
          {typesDraft.types.map((type, index) => (
            <fieldset key={type.id} disabled={busy} className="space-y-2 rounded-lg border p-3">
              <TaskField label="Nom">
                <Input
                  required
                  maxLength={100}
                  value={type.name}
                  onChange={(e) =>
                    setTypesDraft({
                      ...typesDraft,
                      types: typesDraft.types.map((t, i) =>
                        i === index ? { ...t, name: e.target.value } : t,
                      ),
                    })
                  }
                />
              </TaskField>
              <TaskField label="Prompt">
                <Textarea
                  maxLength={20000}
                  value={type.prompt}
                  onChange={(e) =>
                    setTypesDraft({
                      ...typesDraft,
                      types: typesDraft.types.map((t, i) =>
                        i === index ? { ...t, prompt: e.target.value } : t,
                      ),
                    })
                  }
                />
              </TaskField>
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  setTypesDraft({
                    ...typesDraft,
                    types: typesDraft.types.filter((t) => t.id !== type.id),
                  })
                }
              >
                Supprimer le type
              </Button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                setTypesDraft({
                  ...typesDraft,
                  types: [
                    ...typesDraft.types,
                    { id: randomUUID(), name: "Nouveau type", prompt: "" },
                  ],
                })
              }
            >
              Ajouter un type
            </Button>
            <Button type="submit" disabled={busy}>
              Enregistrer les types
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setTypesDraft(null)}
            >
              Fermer
            </Button>
          </div>
        </form>
      )}
      <div className="flex flex-wrap gap-2" aria-label="Filtrer les tâches">
        {FILTERS.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={filter === entry.id ? "secondary" : "ghost"}
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          aria-label="Rechercher une tâche"
          type="search"
          placeholder="Rechercher une tâche…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <TaskProjectSelect
          label="Filtrer par projet"
          projects={selectableProjects}
          value={projectFilter}
          onValueChange={setProjectFilter}
          emptyLabel="Tous les projets"
        />
      </div>
      {(error || query.error || typesQuery.error || chantierQuery.error) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-destructive-foreground"
        >
          <span>{error ?? query.error ?? typesQuery.error ?? chantierQuery.error}</span>
          <Button variant="outline" size="sm" onClick={query.refresh}>
            Actualiser
          </Button>
        </div>
      )}
      {editing && (
        <form
          className="space-y-4 rounded-xl border border-border bg-card p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editorIsStale && !editing.pendingImages?.length)
              void persist(
                editing.expectedVersion === 0
                  ? {
                      id: editing.id,
                      expectedVersion: 0,
                      title: editing.title,
                      notes: editing.notes,
                      attachments: editing.attachments ?? [],
                      projectId: editing.projectId,
                      chantierId: chantierId ?? null,
                      status: "ready",
                      automationMode: "manual",
                      agentThreadId: null,
                      dueDate: null,
                    }
                  : editing,
                true,
              );
          }}
        >
          <h3 className="font-medium">
            {editing.expectedVersion === 0 ? "Nouvelle tâche" : "Détails de la tâche"}
          </h3>
          <fieldset disabled={busy || !canSave} className="space-y-4">
            <TaskField label="Titre">
              <Input
                required
                autoFocus
                maxLength={240}
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
              />
            </TaskField>
            {editing.expectedVersion > 0 && (
              <>
                <TaskField label="Cadre">
                  <TaskSelect
                    value={editing.chantierId ?? ""}
                    onChange={(event) => {
                      const selected = chantiers.find((c) => c.id === event.target.value);
                      setEditing({
                        ...editing,
                        chantierId: selected?.id ?? null,
                        projectId: selected?.projectId ?? editing.projectId,
                        dependsOn: [],
                        externalDependsOn: [],
                      });
                    }}
                  >
                    <option value="">Ponctuelle</option>
                    {chantiers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </TaskSelect>
                </TaskField>
                <WorkSourceEditor
                  sources={editing.sources ?? workTaskSources(editing)}
                  onChange={(sources) => setEditing({ ...editing, sources })}
                />
                {editing.chantierId && (
                  <>
                    <TaskField label="Lot / jalon">
                      <Input
                        maxLength={240}
                        value={editing.milestone ?? ""}
                        onChange={(e) => setEditing({ ...editing, milestone: e.target.value })}
                        placeholder="Premier lot"
                      />
                    </TaskField>
                    <TaskField label="Critères de validation">
                      <Textarea
                        maxLength={10000}
                        value={editing.acceptanceCriteria ?? ""}
                        onChange={(e) =>
                          setEditing({ ...editing, acceptanceCriteria: e.target.value })
                        }
                      />
                    </TaskField>
                    <fieldset className="space-y-2 rounded-lg border p-3">
                      <legend className="px-1 text-sm">Prérequis</legend>
                      {tasks
                        .filter((t) => t.chantierId === editing.chantierId && t.id !== editing.id)
                        .map((t) => (
                          <label key={t.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={editing.dependsOn?.includes(t.id) ?? false}
                              onChange={(e) =>
                                setEditing({
                                  ...editing,
                                  dependsOn: e.target.checked
                                    ? [...(editing.dependsOn ?? []), t.id]
                                    : (editing.dependsOn?.filter((id) => id !== t.id) ?? []),
                                })
                              }
                            />
                            {t.title} · {STATUS_LABELS[t.status]}
                          </label>
                        ))}
                      {chantiers
                        .find((c) => c.id === editing.chantierId)
                        ?.externalDependencies.map((d) => (
                          <label key={d.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={editing.externalDependsOn?.includes(d.id) ?? false}
                              onChange={(e) =>
                                setEditing({
                                  ...editing,
                                  externalDependsOn: e.target.checked
                                    ? [...(editing.externalDependsOn ?? []), d.id]
                                    : (editing.externalDependsOn?.filter((id) => id !== d.id) ??
                                      []),
                                })
                              }
                            />
                            {d.title} · {d.done ? "Livré" : d.owner || "Autre équipe"}
                          </label>
                        ))}
                    </fieldset>
                  </>
                )}
              </>
            )}
            <TaskDescription
              key={editing.id}
              environmentId={environmentId}
              task={editing}
              update={(change) =>
                page.setState((state) =>
                  state.editing?.id === editing.id ? { editing: change(state.editing) } : state,
                )
              }
              setError={setError}
            />
            <TaskField label="Projet">
              <TaskProjectSelect
                label="Projet"
                projects={selectableProjects}
                value={editing.projectId ?? ""}
                emptyLabel="Sans projet"
                onValueChange={(value) =>
                  setEditing({
                    ...editing,
                    projectId: value ? ProjectId.make(value) : null,
                    agentThreadId: null,
                  })
                }
              />
            </TaskField>
            {editing.expectedVersion > 0 && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TaskField label="Type">
                    <TaskSelect
                      value={editing.typeId ?? ""}
                      onChange={(e) => setEditing({ ...editing, typeId: e.target.value || null })}
                    >
                      <option value="">Aucun</option>
                      {editing.typeId &&
                        !typesQuery.data?.types.some((t) => t.id === editing.typeId) && (
                          <option value={editing.typeId}>Type supprimé (Aucun)</option>
                        )}
                      {typesQuery.data?.types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </TaskSelect>
                  </TaskField>
                  <TaskField label="Statut">
                    <TaskSelect
                      value={editing.status}
                      onChange={(event) => {
                        const status = event.target.value;
                        if (
                          status === "ready" ||
                          status === "doing" ||
                          status === "review" ||
                          status === "done" ||
                          status === "rejected" ||
                          status === "merged"
                        )
                          setEditing({ ...editing, status });
                      }}
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </TaskSelect>
                  </TaskField>
                  <TaskField label="Échéance (facultative)">
                    <Input
                      type="date"
                      value={editing.dueDate ?? ""}
                      onChange={(event) =>
                        setEditing({ ...editing, dueDate: event.target.value || null })
                      }
                    />
                  </TaskField>
                  <TaskField label="Discussion associée">
                    <TaskSelect
                      value={editing.agentThreadId ?? ""}
                      onChange={(event) => {
                        const agent = threads.find((t) => t.id === event.target.value);
                        setEditing({
                          ...editing,
                          agentThreadId: agent?.id ?? null,
                          projectId: agent?.projectId ?? editing.projectId,
                        });
                      }}
                    >
                      <option value="">Aucune · pour moi</option>
                      {editing.agentThreadId &&
                        !threads.some((t) => t.id === editing.agentThreadId) && (
                          <option value={editing.agentThreadId}>Discussion indisponible</option>
                        )}
                      {availableThreads.map((thread) => (
                        <option key={thread.id} value={thread.id}>
                          {thread.title} · {thread.providerInstanceId}
                        </option>
                      ))}
                    </TaskSelect>
                  </TaskField>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lancer un agent utilise les réglages de modèle T3 Code et le prompt du type
                  choisi. Le titre, les notes et les messages Slack sont transmis. Les prérequis
                  doivent être terminés ; les tâches de chantier passent à valider après clôture de
                  leur discussion.
                </p>
              </>
            )}
          </fieldset>
          {editing.expectedVersion > 0 && (
            <SlackMessages environmentId={environmentId} taskId={editing.id} />
          )}
          {editorIsStale && (
            <p role="alert" className="text-sm text-destructive-foreground">
              Cette tâche a été modifiée ou supprimée ailleurs. Ferme puis rouvre ses détails pour
              continuer.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={
                busy ||
                !canSave ||
                !editing.title.trim() ||
                editorIsStale ||
                Boolean(editing.pendingImages?.length)
              }
            >
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Fermer
            </Button>
            {editing.expectedVersion > 0 && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy || !canDelete || editorIsStale}
                onClick={() => (confirmDelete ? void deleteTask() : setConfirmDelete(true))}
              >
                {confirmDelete ? "Confirmer la suppression" : "Supprimer"}
              </Button>
            )}
          </div>
        </form>
      )}
      <div className="rounded-xl border border-border bg-card">
        {query.data === null && !query.error ? (
          <p className="p-6 text-sm text-muted-foreground">Chargement des tâches…</p>
        ) : visible.length === 0 ? (
          <div className="space-y-2 p-8 text-center">
            <ListTodoIcon className="mx-auto size-7 text-muted-foreground" />
            <p className="font-medium">
              {tasks.length === 0 ? "Ta liste commence ici" : "Aucune tâche pour ce filtre"}
            </p>
            <p className="text-sm text-muted-foreground">
              {tasks.length === 0
                ? "Ajoute une première tâche, pour toi ou pour un agent."
                : "Essaie un autre filtre ou une autre recherche."}
            </p>
          </div>
        ) : (
          visible.map((task) => {
            const agent = threads.find((t) => t.id === task.agentThreadId);
            const project = projects.find((entry) => entry.id === task.projectId);
            const modelSelection = resolveDefaultProviderModelSelection(
              providers,
              resolveProjectSettings(settings, task.projectId, project).settings
                .defaultModelSelection,
            );
            let launchUnavailableReason: string | undefined;
            if (task.status !== "ready") launchUnavailableReason = "La tâche doit être À démarrer";
            else if (!task.projectId)
              launchUnavailableReason = "Choisis un projet dans les détails";
            else if (!modelSelection)
              launchUnavailableReason = "Aucun modèle disponible sur ce serveur";
            return (
              <div
                key={task.id}
                style={
                  {
                    "--label": STATUS_PRESENTATION[task.status].color,
                    backgroundColor: "color-mix(in srgb, var(--label) 6%, transparent)",
                  } as CSSProperties
                }
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-b border-border p-4 first:rounded-t-xl last:rounded-b-xl last:border-0"
              >
                <div className="pt-1">
                  <Checkbox
                    aria-label={
                      isClosedWorkTaskStatus(task.status)
                        ? `Rouvrir ${task.title}`
                        : `Terminer ${task.title}`
                    }
                    checked={isClosedWorkTaskStatus(task.status)}
                    disabled={!canSave || busy || editing?.id === task.id}
                    onCheckedChange={(checked) =>
                      void persist(
                        {
                          ...task,
                          expectedVersion: task.version,
                          status: checked ? "done" : "ready",
                        },
                        false,
                      )
                    }
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <button
                    type="button"
                    className={`block w-full text-left text-sm font-medium break-words outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}
                    disabled={busy}
                    onClick={() => beginEdit(task)}
                  >
                    {task.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {project && (
                        <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">
                        {task.projectId ? (project?.title ?? "Projet indisponible") : "Sans projet"}
                      </span>
                    </span>
                    {task.qualifiedAt && (
                      <span>
                        Qualifiée le{" "}
                        <time dateTime={task.qualifiedAt}>
                          {new Date(task.qualifiedAt).toLocaleString("fr-FR", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </span>
                    )}
                    {task.dueDate && (
                      <span>
                        Échéance :{" "}
                        {new Date(`${task.dueDate}T12:00:00`).toLocaleDateString("fr-FR")}
                      </span>
                    )}
                    <span>
                      {agent?.title ??
                        (task.agentThreadId ? "Discussion indisponible" : "Pour moi")}
                    </span>
                  </div>
                </div>
                <Badge variant="label">{STATUS_LABELS[task.status]}</Badge>
                <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {task.chantierId ? (
                    <Link
                      to="/tasks"
                      search={{
                        tab: "chantiers",
                        chantier: task.chantierId,
                        view: "discussion",
                        environment: environmentId,
                      }}
                      className="text-primary hover:underline"
                    >
                      Cadre · {chantiers.find((c) => c.id === task.chantierId)?.title ?? "Chantier"}{" "}
                      · Orchestrateur
                    </Link>
                  ) : (
                    <span>Ponctuelle</span>
                  )}
                  {workTaskSources(task).map((source, index) =>
                    source.url ? (
                      <a
                        key={index}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {source.label}
                      </a>
                    ) : (
                      <span key={index}>{source.label}</span>
                    ),
                  )}
                  {task.milestone && <span>Lot · {task.milestone}</span>}
                  {workTaskBlockers(
                    task,
                    tasks,
                    chantiers.find((c) => c.id === task.chantierId)?.externalDependencies,
                  ).length > 0 && (
                    <span className="text-warning">
                      En attente :{" "}
                      {workTaskBlockers(
                        task,
                        tasks,
                        chantiers.find((c) => c.id === task.chantierId)?.externalDependencies,
                      ).join(", ")}
                    </span>
                  )}
                </div>
                <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-3 pt-2">
                  <span className="text-xs text-muted-foreground">
                    {typesQuery.data?.types.find((t) => t.id === task.typeId)?.name ?? "Aucun"}
                  </span>
                  <div className="ml-auto">
                    {task.agentThreadId ? (
                      <Link
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: task.agentThreadId }}
                      >
                        <BotIcon className="size-3" />
                        Voir la discussion
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy ||
                          !canLaunch ||
                          !task.projectId ||
                          !modelSelection ||
                          task.status !== "ready" ||
                          workTaskBlockers(
                            task,
                            tasks,
                            chantiers.find((c) => c.id === task.chantierId)?.externalDependencies,
                          ).length > 0 ||
                          (!!task.chantierId &&
                            chantiers.find((c) => c.id === task.chantierId)?.status !== "active")
                        }
                        title={launchUnavailableReason}
                        onClick={async () => {
                          if (!modelSelection) return;
                          setBusy(true);
                          setError(null);
                          try {
                            const result = await launch({
                              environmentId,
                              input: {
                                id: task.id,
                                expectedVersion: task.version,
                                modelSelection,
                              },
                            });
                            if (result._tag === "Failure")
                              setError(String(squashAtomCommandFailure(result)));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <BotIcon />
                        Lancer un agent
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {tasks.filter((task) => !isClosedWorkTaskStatus(task.status)).length} ouvertes ·{" "}
        {tasks.filter((task) => task.status === "done").length} terminées
      </p>
    </>
  );
}

function SlackMessages({
  environmentId,
  taskId,
}: {
  environmentId: EnvironmentId;
  taskId: string;
}) {
  const query = useEnvironmentQuery(workTaskMessages({ environmentId, input: { id: taskId } }));
  if (query.error) return <p role="alert">{query.error}</p>;
  if (query.data === null)
    return <p className="text-sm text-muted-foreground">Chargement des messages…</p>;
  return query.data.map((message) => (
    <div
      key={`${message.workspaceId}:${message.channelId}:${message.ts}`}
      className="space-y-1 rounded-lg border border-border p-3 text-sm"
    >
      <a
        className="text-primary hover:underline"
        target="_blank"
        rel="noreferrer"
        href={`https://app.slack.com/client/${message.workspaceId}/${message.channelId}/thread/${message.channelId}-${message.threadTs}?message_ts=${message.ts}`}
      >
        {message.channelName || "Slack"} · {message.authorId} ·{" "}
        {new Date(Number(message.ts) * 1000).toLocaleString("fr-FR")}
      </a>
      <p className="whitespace-pre-wrap break-words">{message.text}</p>
    </div>
  ));
}
