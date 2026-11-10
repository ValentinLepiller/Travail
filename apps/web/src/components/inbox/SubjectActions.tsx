import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  ProjectId,
  isClosedWorkTaskStatus,
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
import { workTasks, workChantiers } from "../../state/workTasks";
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

type FormProps = Props & {
  mode: "create" | "update" | "complete";
  onCancel: () => void;
};

function SubjectTaskForm(props: FormProps) {
  const query = useEnvironmentQuery(
    props.mode !== "create" ? workTasks({ environmentId: props.environmentId, input: {} }) : null,
  );
  if (props.mode === "create") return <SubjectTaskEditor {...props} task={null} />;
  const taskId =
    props.subject.taskId ??
    (props.subject.context?.kind === "task" ? props.subject.context.id : null);
  const task = query.data?.find((entry) => entry.id === taskId);
  if (!task || isClosedWorkTaskStatus(task.status))
    return (
      <div className="my-3 space-y-2">
        <p role={query.isPending ? "status" : "alert"}>
          {query.isPending
            ? "Chargement de la tâche liée…"
            : query.error ||
              (props.subject.taskId && task?.status === "done"
                ? "La tâche liée est terminée. Ce sujet est définitivement clos."
                : "La tâche liée n’est plus disponible. Actualisez le sujet.")}
        </p>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Annuler
        </Button>
      </div>
    );
  return <SubjectTaskEditor {...props} task={task} />;
}

function SubjectTaskEditor({
  environmentId,
  subject,
  mode,
  onSaved,
  onCancel,
  task,
}: FormProps & { task: WorkTask | null }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const chantiers = useEnvironmentQuery(
    mode === "create" ? workChantiers({ environmentId, input: {} }) : null,
  );
  const [project, setProject] = useState(task?.projectId ?? subject.context?.projectId ?? "");
  const [chantier, setChantier] = useState(
    mode === "create" && subject.context?.kind === "chantier" ? subject.context.id : "",
  );
  const [selected] = useState(task);
  const [title, setTitle] = useState(task?.title ?? subject.title);
  const [description, setDescription] = useState(
    mode === "create" || (mode === "complete" && !subject.taskId) ? subject.summary : "",
  );
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useAtomCommand(applyInboxSubjectAction);
  const canSave = useAtomValue(applyInboxSubjectAction.permissionAtom(environmentId));
  const stale = selected && selected.version !== task?.version;
  const save = async () => {
    if (saving.current || !canSave || stale || (mode !== "create" && !selected)) return;
    const common = {
      subjectId: subject.id,
      expectedVersion: subject.actionVersion ?? 0,
      title,
      description,
      projectId: project ? ProjectId.make(project) : null,
    };
    const action: InboxSubjectActionInput =
      mode === "complete" && selected
        ? {
            subjectId: subject.id,
            expectedVersion: subject.actionVersion ?? 0,
            kind: "complete",
            taskId: selected.id,
            taskVersion: selected.version,
            description,
            requestId: "",
          }
        : mode === "update" && selected
          ? {
              ...common,
              kind: "update",
              taskId: selected.id,
              taskVersion: selected.version,
              requestId: "",
            }
          : { ...common, kind: "create", chantierId: chantier || null, requestId: "" };
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
        {mode === "create"
          ? "Créer une tâche"
          : mode === "complete"
            ? "Compléter la tâche"
            : "Mettre à jour la tâche"}
      </h3>
      <fieldset className="space-y-3" disabled={busy || !canSave}>
        {selected ? (
          <p className="text-sm text-muted-foreground">Tâche liée : {selected.title}</p>
        ) : null}
        <TaskField label="Projet">
          <TaskSelect
            disabled={mode !== "create"}
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setChantier("");
            }}
          >
            <option value="">Sans projet</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </TaskSelect>
        </TaskField>
        {mode === "create" ? (
          <TaskField label="Chantier">
            <TaskSelect value={chantier} onChange={(event) => setChantier(event.target.value)}>
              <option value="">Sans chantier</option>
              {chantier && !chantiers.data?.some((c) => c.id === chantier) && (
                <option value={chantier}>{subject.contextLabel ?? chantier}</option>
              )}
              {chantiers.data
                ?.filter((c) => c.projectId === project && c.status !== "done")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </TaskSelect>
          </TaskField>
        ) : null}
        {mode === "complete" ? (
          <p className="text-sm font-medium">{selected?.title}</p>
        ) : (
          <TaskField label="Titre">
            <Input
              required
              maxLength={240}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </TaskField>
        )}
        {selected ? (
          <div className="text-sm">
            <p>Notes existantes conservées</p>
            <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
              {selected.notes || "Aucune note."}
            </p>
          </div>
        ) : null}
        <TaskField label={mode !== "create" ? "Informations à ajouter" : "Description"}>
          <Textarea
            maxLength={20_000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </TaskField>
        <p className="text-xs text-muted-foreground">
          Les sources sont conservées. Aucun agent ne sera lancé et aucun message ne sera envoyé à
          sa discussion.
        </p>
        {stale ? (
          <p role="alert">
            La tâche a changé. Fermez ce formulaire puis rouvrez-le pour revoir sa version actuelle.
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
            disabled={Boolean(stale) || !title.trim() || (mode !== "create" && !selected)}
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
  const taskId = subject.taskId ?? (subject.context?.kind === "task" ? subject.context.id : null);
  const [mode, setMode] = useState<"create" | "update" | "complete" | null>(null);
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
        {!subject.ignored && !subject.closedAt ? (
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
            {!subject.taskId && subject.context?.kind === "task" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => setMode("complete")}
              >
                Compléter la tâche
              </Button>
            ) : null}
            {subject.taskId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() =>
                  setMode(subject.taskLinkKind === "completed" ? "complete" : "update")
                }
              >
                {subject.taskLinkKind === "completed"
                  ? "Compléter la tâche"
                  : "Mettre à jour la tâche"}
              </Button>
            ) : null}
          </>
        ) : null}
        {!subject.closedAt ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!canSave || busy}
            onClick={() => void ignore()}
          >
            {subject.ignored ? "Rétablir ce sujet" : "Ignorer ce sujet"}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Sujet définitivement terminé.</p>
        )}
        {taskId ? (
          <Link
            to="/tasks"
            search={{ environment: environmentId, task: taskId }}
            className="text-sm text-primary underline"
          >
            {subject.taskId ? "Ouvrir la tâche liée" : "Voir la tâche proposée"}
          </Link>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {mode && !subject.closedAt ? (
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
