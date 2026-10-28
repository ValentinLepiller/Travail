import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ProjectId,
  type EnvironmentId,
  type WorkTask,
  type WorkTaskSaveInput,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ListTodoIcon, PlusIcon, BotIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { workTasks, saveWorkTask, deleteWorkTask } from "../../state/workTasks";
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

const STATUS_LABELS = {
  todo: "À faire",
  doing: "En cours",
  review: "À valider",
  done: "Terminée",
} satisfies Record<WorkTask["status"], string>;
const FILTERS = [
  { id: "all", label: "Tout" },
  { id: "mine", label: "Pour moi" },
  { id: "agents", label: "Agents" },
  { id: "review", label: "À valider" },
  { id: "done", label: "Terminées" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

function TaskSelect(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
    />
  );
}

function TaskField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function WorkTasksPage() {
  const primaryId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = selectedEnvironmentId ?? primaryId;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <ListTodoIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Tâches</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          {environments.length > 1 && (
            <TaskField label="Machine">
              <TaskSelect
                value={environmentId ?? ""}
                onChange={(event) => {
                  setSelectedEnvironmentId(
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
            <EnvironmentTasks key={environmentId} environmentId={environmentId} />
          ) : (
            <p>Connecte une machine pour retrouver tes tâches.</p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function EnvironmentTasks({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(workTasks({ environmentId, input: {} }));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && thread.deletedAt === null,
  );
  const canSave = useAtomValue(saveWorkTask.permissionAtom(environmentId));
  const canDelete = useAtomValue(deleteWorkTask.permissionAtom(environmentId));
  const save = useAtomCommand(saveWorkTask);
  const remove = useAtomCommand(deleteWorkTask);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [editing, setEditing] = useState<WorkTaskSaveInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tasks = query.data ?? [];
  const visible = tasks.filter((task) => {
    if (projectFilter && task.projectId !== projectFilter) return false;
    if (
      search &&
      !`${task.title} ${task.notes}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    )
      return false;
    switch (filter) {
      case "mine":
        return task.agentThreadId === null && task.status !== "done";
      case "agents":
        return task.agentThreadId !== null && task.status !== "done";
      case "review":
        return task.status === "review";
      case "done":
        return task.status === "done";
      default:
        return true;
    }
  });
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
            status: "todo",
            projectId: projectFilter ? ProjectId.make(projectFilter) : null,
            agentThreadId: null,
            dueDate: null,
          },
    );
  };
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
  const selectedAgent = threads.find((thread) => thread.id === editing?.agentThreadId);
  const editorIsStale =
    editing !== null &&
    editing.expectedVersion > 0 &&
    query.data !== null &&
    tasks.find((task) => task.id === editing.id)?.version !== editing.expectedVersion;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Les choses à faire</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tes tâches et celles confiées aux agents, au même endroit.
          </p>
        </div>
        <Button disabled={!canSave || busy} onClick={() => beginEdit()}>
          <PlusIcon />
          Nouvelle tâche
        </Button>
      </div>
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
        <TaskSelect
          aria-label="Filtrer par projet"
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
        >
          <option value="">Tous les projets</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </TaskSelect>
      </div>
      {(error || query.error) && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-destructive-foreground"
        >
          <span>{error ?? query.error}</span>
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
            if (!editorIsStale) void persist(editing, true);
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
            <TaskField label="Notes">
              <Textarea
                maxLength={20_000}
                value={editing.notes}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
              />
            </TaskField>
            <div className="grid gap-4 sm:grid-cols-2">
              <TaskField label="Statut">
                <TaskSelect
                  value={editing.status}
                  onChange={(event) => {
                    const status = event.target.value;
                    if (
                      status === "todo" ||
                      status === "doing" ||
                      status === "review" ||
                      status === "done"
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
              <TaskField label="Projet">
                <TaskSelect
                  value={editing.projectId ?? ""}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      projectId: event.target.value ? ProjectId.make(event.target.value) : null,
                      agentThreadId: null,
                    })
                  }
                >
                  <option value="">Sans projet</option>
                  {editing.projectId &&
                    !projects.some((project) => project.id === editing.projectId) && (
                      <option value={editing.projectId}>Projet indisponible</option>
                    )}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </TaskSelect>
              </TaskField>
              <TaskField label="Attribuer à un agent">
                <TaskSelect
                  value={editing.agentThreadId ?? ""}
                  onChange={(event) => {
                    const agent = threads.find((thread) => thread.id === event.target.value);
                    setEditing({
                      ...editing,
                      agentThreadId: agent?.id ?? null,
                      projectId: agent?.projectId ?? editing.projectId,
                    });
                  }}
                >
                  <option value="">Pour moi · aucun agent</option>
                  {editing.agentThreadId && !selectedAgent && (
                    <option value={editing.agentThreadId}>Agent indisponible</option>
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
              Choisir un agent associe sa conversation à la tâche. Ouvre-la pour lui transmettre une
              consigne. Le statut de la tâche reste manuel.
            </p>
          </fieldset>
          {editorIsStale && (
            <p role="alert" className="text-sm text-destructive-foreground">
              Cette tâche a été modifiée ou supprimée ailleurs. Ferme puis rouvre ses détails pour
              continuer.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={busy || !canSave || !editing.title.trim() || editorIsStale}
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
            const agent = threads.find((thread) => thread.id === task.agentThreadId);
            const project = projects.find((entry) => entry.id === task.projectId);
            return (
              <div
                key={task.id}
                className="flex items-start gap-3 border-b border-border p-4 last:border-0"
              >
                <div className="pt-1">
                  <Checkbox
                    aria-label={
                      task.status === "done" ? `Rouvrir ${task.title}` : `Terminer ${task.title}`
                    }
                    checked={task.status === "done"}
                    disabled={!canSave || busy || editing?.id === task.id}
                    onCheckedChange={(checked) =>
                      void persist(
                        {
                          ...task,
                          expectedVersion: task.version,
                          status: checked ? "done" : "todo",
                        },
                        false,
                      )
                    }
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <button
                    type="button"
                    className={`block w-full text-left text-sm font-medium break-words outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${task.status === "done" ? "text-muted-foreground line-through" : ""}`}
                    disabled={busy}
                    onClick={() => beginEdit(task)}
                  >
                    {task.title}
                  </button>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {task.projectId ? (project?.title ?? "Projet indisponible") : "Sans projet"}
                    </span>
                    {task.dueDate && (
                      <span>
                        Échéance :{" "}
                        {new Date(`${task.dueDate}T12:00:00`).toLocaleDateString("fr-FR")}
                      </span>
                    )}
                    {agent ? (
                      <Link
                        className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: agent.id }}
                      >
                        <BotIcon className="size-3 shrink-0" />
                        <span className="truncate">{agent.title}</span>
                      </Link>
                    ) : (
                      <span>{task.agentThreadId ? "Agent indisponible" : "Pour moi"}</span>
                    )}
                  </div>
                </div>
                <Badge variant={task.status === "done" ? "secondary" : "outline"}>
                  {STATUS_LABELS[task.status]}
                </Badge>
              </div>
            );
          })
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {tasks.filter((task) => task.status !== "done").length} à faire ·{" "}
        {tasks.filter((task) => task.status === "done").length} terminées
      </p>
    </>
  );
}
