import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ProjectId,
  type EnvironmentId,
  type InboxSubject,
  type InboxSubjectActionInput,
  type InboxSubjectActionResult,
  type WorkTask,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { applyInboxSubjectAction } from "../../state/inboxSubjects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { workTasks } from "../../state/workTasks";
import { useProjects } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { TaskField, TaskSelect } from "../workTasks/TaskFormFields";

type Result = typeof InboxSubjectActionResult.Type;
type Props = {
  environmentId: EnvironmentId;
  subject: InboxSubject;
  onSaved: (result: Result) => void;
};

function SubjectTaskForm({
  environmentId,
  subject,
  mode,
  onSaved,
  onCancel,
}: Props & {
  mode: "create" | "update";
  onCancel: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const query = useEnvironmentQuery(
    mode === "update" ? workTasks({ environmentId, input: {} }) : null,
  );
  const [project, setProject] = useState("");
  const [selected, setSelected] = useState<WorkTask | null>(null);
  const [title, setTitle] = useState(mode === "create" ? subject.title : "");
  const [description, setDescription] = useState(subject.summary);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useAtomCommand(applyInboxSubjectAction);
  const canSave = useAtomValue(applyInboxSubjectAction.permissionAtom(environmentId));
  const choose = (id: string) => {
    const task = query.data?.find((task) => task.id === id) ?? null;
    setSelected(task);
    setProject(task?.projectId ?? "");
    setTitle(task?.title ?? "");
    setError(null);
  };
  const stale =
    selected &&
    query.data !== null &&
    !query.data.some((task) => task.id === selected.id && task.version === selected.version);
  const save = async () => {
    if (saving.current || !canSave || stale || (mode === "update" && !selected)) return;
    const common = {
      subjectId: subject.id,
      expectedVersion: subject.actionVersion ?? 0,
      title,
      description,
      projectId: project ? ProjectId.make(project) : null,
    };
    const action =
      mode === "update" && selected
        ? { ...common, kind: "update" as const, taskId: selected.id, taskVersion: selected.version }
        : { ...common, kind: "create" as const };
    const payload = JSON.stringify(action);
    if (request.current?.payload !== payload) request.current = { payload, id: randomUUID() };
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await apply({
        environmentId,
        input: { ...action, requestId: request.current.id },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else onSaved(result.value);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="my-3 space-y-3 rounded-xl border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-medium">
        {mode === "create" ? "Créer une tâche" : "Mettre à jour la tâche"}
      </h3>
      <fieldset className="space-y-3" disabled={busy || !canSave}>
        {mode === "update" ? (
          <TaskField label="Tâche à mettre à jour">
            <TaskSelect
              required
              value={selected?.id ?? ""}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="">Choisir explicitement une tâche</option>
              {(query.data ?? []).map((task) => (
                <option key={task.id} value={task.id}>
                  {task.id === subject.taskId ? "Liée · " : ""}
                  {task.title} ·{" "}
                  {projects.find((p) => p.id === task.projectId)?.title ?? "Sans projet"}
                </option>
              ))}
            </TaskSelect>
          </TaskField>
        ) : null}
        {query.error && mode === "update" ? <p role="alert">{query.error}</p> : null}
        <TaskField label="Projet">
          <TaskSelect
            disabled={mode === "update"}
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">Sans projet</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </TaskSelect>
        </TaskField>
        <TaskField label="Titre">
          <Input
            required
            maxLength={240}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </TaskField>
        {selected ? (
          <div className="text-sm">
            <p>Notes existantes conservées</p>
            <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
              {selected.notes || "Aucune note."}
            </p>
          </div>
        ) : null}
        <TaskField label={mode === "update" ? "Description à ajouter" : "Description"}>
          <Textarea
            maxLength={20_000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </TaskField>
        <p className="text-xs text-muted-foreground">
          Les sources sont conservées. Cette tâche restera manuelle, sans lancement automatique
          d’agent.
        </p>
        {stale ? (
          <p role="alert">
            La tâche a changé. Sélectionnez-la à nouveau pour revoir sa version actuelle.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={Boolean(stale) || !title.trim() || (mode === "update" && !selected)}
          >
            {busy ? "Enregistrement…" : "Valider et enregistrer"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Annuler
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function SubjectActions({ environmentId, subject, onSaved }: Props) {
  const [mode, setMode] = useState<"create" | "update" | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const apply = useAtomCommand(applyInboxSubjectAction);
  const canSave = useAtomValue(applyInboxSubjectAction.permissionAtom(environmentId));
  const ignore = async () => {
    if (saving.current || !canSave) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    const input: InboxSubjectActionInput = {
      kind: "ignore",
      subjectId: subject.id,
      expectedVersion: subject.actionVersion ?? 0,
      ignored: !subject.ignored,
      requestId: `ignore:${subject.id}:${subject.actionVersion ?? 0}:${!subject.ignored}`,
    };
    try {
      const result = await apply({ environmentId, input });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else {
        onSaved(result.value);
        setMode(null);
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="my-3">
      <div className="flex flex-wrap items-center gap-2">
        {!subject.ignored ? (
          <>
            {!subject.taskId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => setMode("create")}
              >
                Créer une tâche
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!canSave || busy}
              onClick={() => setMode("update")}
            >
              Mettre à jour la tâche
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" disabled={!canSave || busy} onClick={() => void ignore()}>
          {subject.ignored ? "Rétablir ce sujet" : "Ignorer ce sujet"}
        </Button>
        {subject.taskId ? (
          <Link
            to="/tasks"
            search={{ environment: environmentId, task: subject.taskId }}
            className="text-sm text-primary underline"
          >
            Ouvrir la tâche liée
          </Link>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {mode ? (
        <SubjectTaskForm
          key={mode}
          environmentId={environmentId}
          subject={subject}
          mode={mode}
          onSaved={(result) => {
            onSaved(result);
            setMode(null);
          }}
          onCancel={() => setMode(null)}
        />
      ) : null}
    </div>
  );
}
