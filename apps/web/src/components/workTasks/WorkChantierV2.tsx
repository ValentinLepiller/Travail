import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { openPreviewSession } from "../preview/openPreviewSession";
import { PreviewPanel } from "../preview/PreviewPanel";
import { previewEnvironment } from "../../state/preview";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  AutonomousAgent,
  WorkChantier,
  WorkTask,
  ChantierV2Command,
  ChantierProjectPolicy,
  PreviewAnnotationPayload,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { autonomousAgents, autonomousAgentDetail } from "../../state/autonomousAgents";
import {
  commandWorkChantierV2,
  chantierProjectPolicy,
  saveChantierProjectPolicy,
} from "../../state/workTasks";
import { ChefConversation } from "../chefs/ChefsPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { randomUUID } from "../../lib/utils";

type Execute = (input: ChantierV2Command) => Promise<WorkChantier | null>;

export function WorkChantierV2({
  environmentId,
  chantier,
  tasks,
  discussion,
  onLaunch,
}: {
  environmentId: EnvironmentId;
  chantier: WorkChantier;
  tasks: readonly WorkTask[];
  discussion: boolean;
  onLaunch: () => void;
}) {
  const agents = useEnvironmentQuery(autonomousAgents({ environmentId, input: {} }));
  const chef = agents.data?.find((a) => a.id === chantier.v2?.chefAgentId);
  const command = useAtomCommand(commandWorkChantierV2);
  const allowed = useAtomValue(commandWorkChantierV2.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v2 = chantier.v2!;
  const execute = async (input: ChantierV2Command) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return null;
      }
      return result.value;
    } finally {
      setBusy(false);
    }
  };
  const identity = { id: chantier.id, expectedVersion: chantier.version };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Chantier V2 · {v2.framingApproved ? "Cadrage approuvé" : "Cadrage à approuver"} ·{" "}
        {v2.stopped ? "Arrêt immédiat" : chantier.status}
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy || !allowed} className="flex flex-wrap gap-2">
        {!v2.framingApproved && (
          <Button onClick={() => void execute({ ...identity, type: "approveFraming" })}>
            Approuver le cadrage
          </Button>
        )}
        {chantier.status === "active" && (
          <Button variant="outline" onClick={() => void execute({ ...identity, type: "pause" })}>
            Mettre en pause
          </Button>
        )}
        {chantier.status === "paused" && (
          <Button onClick={() => void execute({ ...identity, type: "resume" })}>Reprendre</Button>
        )}
        {chantier.status !== "done" && (
          <Button variant="outline" onClick={() => void execute({ ...identity, type: "stop" })}>
            Arrêter immédiatement les agents
          </Button>
        )}
        {chantier.status !== "done" && (
          <Button variant="outline" onClick={() => void execute({ ...identity, type: "close" })}>
            Confirmer la clôture après bilan
          </Button>
        )}
        {chantier.status === "done" && (
          <Button onClick={() => void execute({ ...identity, type: "reopen" })}>Rouvrir</Button>
        )}
      </fieldset>
      {discussion ? (
        chef ? (
          <div className="flex min-h-[500px] flex-col rounded-xl border">
            <ChefConversation agent={chef} environmentId={environmentId} />
          </div>
        ) : (
          <Button disabled={busy || !allowed} onClick={onLaunch}>
            Démarrer le Chef de chantier
          </Button>
        )
      ) : (
        <>
          <Dossier
            key={chantier.id}
            environmentId={environmentId}
            chef={chef}
            chantier={chantier}
            disabled={busy || !allowed}
            execute={execute}
          />
          <section className="space-y-3 rounded-xl border p-4">
            <h3 className="font-medium">Tâches et accords</h3>
            <p className="text-sm text-muted-foreground">
              L’approbation d’une tâche de code autorise sa branche et sa PR. Les accords
              indépendants de Valentin et du Chef sur le dernier code déclenchent le merge. Le
              déploiement attend un go distinct.
            </p>
            {tasks.map((task) => (
              <TaskAgreements
                key={`${task.id}:${task.version}`}
                chantier={chantier}
                task={task}
                disabled={busy || !allowed}
                execute={execute}
              />
            ))}
          </section>
          <ProjectPolicy environmentId={environmentId} chantier={chantier} />
        </>
      )}
    </div>
  );
}

function Dossier({
  environmentId,
  chef,
  chantier,
  disabled,
  execute,
}: {
  environmentId: EnvironmentId;
  chef: AutonomousAgent | undefined;
  chantier: WorkChantier;
  disabled: boolean;
  execute: Execute;
}) {
  const [draft, setDraft] = useState(chantier.v2!);
  const [saved, setSaved] = useState({ state: chantier.v2!, version: chantier.version });
  const stale = saved.version !== chantier.version;
  if (stale && draft === saved.state) {
    setDraft(chantier.v2!);
    setSaved({ state: chantier.v2!, version: chantier.version });
  }
  const identity = { id: chantier.id, expectedVersion: saved.version };
  const persist: Execute = async (input) => {
    const next = await execute(input);
    if (next) {
      setDraft(next.v2!);
      setSaved({ state: next.v2!, version: next.version });
    }
    return next;
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
      {stale && (
        <p role="alert" className="lg:col-span-2">
          Le dossier a changé ; tes modifications sont conservées.{" "}
          <Button
            variant="outline"
            onClick={() => {
              setDraft(chantier.v2!);
              setSaved({ state: chantier.v2!, version: chantier.version });
            }}
          >
            Recharger le dossier actuel
          </Button>
        </p>
      )}
      <form
        className="min-w-0 space-y-3 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void persist({
            ...identity,
            type: "dossier",
            completionCriteria: draft.completionCriteria,
            interfaceExpected: draft.interfaceExpected,
            specifications: draft.specifications,
            prototype: draft.prototype,
            stages: draft.stages,
          });
        }}
      >
        <fieldset disabled={disabled || stale} className="min-w-0 space-y-3">
          <legend className="font-medium">Dossier du chantier</legend>
          <label className="block text-sm">
            Critères de fin
            <Textarea
              value={draft.completionCriteria}
              onChange={(e) => setDraft({ ...draft, completionCriteria: e.target.value })}
            />
          </label>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.interfaceExpected}
              onChange={(e) => setDraft({ ...draft, interfaceExpected: e.target.checked })}
            />
            Une interface est prévue
          </label>
          <label className="block text-sm">
            Spécifications
            <Textarea
              value={draft.specifications}
              onChange={(e) => setDraft({ ...draft, specifications: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Prototype
            <select
              className="ml-2 rounded border bg-background p-2"
              value={draft.prototype.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  prototype: {
                    ...draft.prototype,
                    status: e.target.value as typeof draft.prototype.status,
                  },
                })
              }
            >
              <option value="pending">À préparer</option>
              <option value="ready">Essayable</option>
              <option value="skipped">Je choisis de sauter le prototype</option>
            </select>
          </label>
          <label className="block text-sm">
            Adresse du prototype
            <Input
              type="url"
              value={draft.prototype.url ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  prototype: { ...draft.prototype, url: e.target.value || null },
                })
              }
            />
          </label>
          <label className="block text-sm">
            Code d’exemple
            <Input
              value={draft.prototype.codeReference}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  prototype: { ...draft.prototype, codeReference: e.target.value },
                })
              }
            />
          </label>
          <label className="block text-sm">
            Comportements attendus et notes du prototype
            <Textarea
              value={draft.prototype.notes}
              onChange={(e) =>
                setDraft({ ...draft, prototype: { ...draft.prototype, notes: e.target.value } })
              }
            />
          </label>
          {draft.prototype.annotations.map((a) => (
            <div key={a.id} className="space-y-2">
              <Input
                aria-label="Écran ou élément annoté"
                value={a.target}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    prototype: {
                      ...draft.prototype,
                      annotations: draft.prototype.annotations.map((v) =>
                        v.id === a.id ? { ...v, target: e.target.value } : v,
                      ),
                    },
                  })
                }
              />
              <Textarea
                aria-label="Annotation"
                value={a.text}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    prototype: {
                      ...draft.prototype,
                      annotations: draft.prototype.annotations.map((v) =>
                        v.id === a.id ? { ...v, text: e.target.value } : v,
                      ),
                    },
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setDraft({
                ...draft,
                prototype: {
                  ...draft.prototype,
                  annotations: [
                    ...draft.prototype.annotations,
                    { id: randomUUID(), target: "", text: "" },
                  ],
                },
              })
            }
          >
            Ajouter une annotation
          </Button>
          <h4 className="text-sm font-medium">Grandes étapes du plan</h4>
          {draft.stages.map((stage) => (
            <div key={stage.id} className="space-y-2">
              <Input
                aria-label="Étape"
                value={stage.title}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    stages: draft.stages.map((s) =>
                      s.id === stage.id ? { ...s, title: e.target.value } : s,
                    ),
                  })
                }
              />
              <Textarea
                aria-label="Critères de l’étape"
                value={stage.criteria}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    stages: draft.stages.map((s) =>
                      s.id === stage.id ? { ...s, criteria: e.target.value } : s,
                    ),
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={!draft.framingApproved}
            onClick={() =>
              setDraft({
                ...draft,
                stages: [
                  ...draft.stages,
                  { id: randomUUID(), title: "Nouvelle étape", criteria: "" },
                ],
              })
            }
          >
            Ajouter une étape
          </Button>
          <Button type="submit">Enregistrer le dossier</Button>
        </fieldset>
      </form>
      <form
        className="min-w-0 space-y-3 rounded-xl border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void persist({
            ...identity,
            type: "memory",
            memory: draft.memory,
            finalReview: draft.finalReview,
          });
        }}
      >
        <fieldset disabled={disabled || stale} className="min-w-0 space-y-3">
          <legend className="font-medium">Mémoire courte et bilan</legend>
          <label className="block text-sm">
            Avancement, attentes, blocages, prochaines actions
            <Textarea
              value={draft.memory}
              onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Bilan avant clôture
            <Textarea
              value={draft.finalReview}
              onChange={(e) => setDraft({ ...draft, finalReview: e.target.value })}
            />
          </label>
          <Button type="submit">Enregistrer la mémoire</Button>
        </fieldset>
      </form>
      {draft.prototype.url && chef && (
        <PrototypeBrowser
          environmentId={environmentId}
          chef={chef}
          url={draft.prototype.url}
          onCaptureAnnotation={(annotation) =>
            setDraft((current) => ({
              ...current,
              prototype: {
                ...current.prototype,
                annotations: [
                  ...current.prototype.annotations,
                  {
                    id: annotation.id,
                    target: `${annotation.pageTitle ?? "Prototype"} · ${annotation.pageUrl}`,
                    text: annotation.comment,
                    capture: { ...annotation, screenshot: null },
                  },
                ],
              },
            }))
          }
        />
      )}
    </div>
  );
}

function PrototypeBrowser({
  environmentId,
  chef,
  url,
  onCaptureAnnotation,
}: {
  environmentId: EnvironmentId;
  chef: AutonomousAgent;
  url: string;
  onCaptureAnnotation: (annotation: PreviewAnnotationPayload) => void;
}) {
  const detail = useEnvironmentQuery(
    autonomousAgentDetail({ environmentId, input: { id: chef.id } }),
  );
  const openPreview = useAtomCommand(previewEnvironment.open);
  const allowed = useAtomValue(previewEnvironment.open.permissionAtom(environmentId));
  const [session, setSession] = useState<{ threadRef: ScopedThreadRef; tabId: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const threadId = chef.currentThreadId ?? detail.data?.history[0]?.threadId;
  return (
    <section className="space-y-3 rounded-xl border p-4 lg:col-span-2">
      <Button
        type="button"
        variant="outline"
        disabled={!allowed || !threadId}
        onClick={() => {
          if (!threadId) return;
          const threadRef = scopeThreadRef(environmentId, threadId);
          setError("");
          void openPreviewSession({
            threadRef,
            url,
            openPreview,
          }).then((result) => {
            if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
            else setSession({ threadRef, tabId: result.value.tabId });
          });
        }}
      >
        Essayer et annoter le prototype
      </Button>
      {error && <p role="alert">{error}</p>}
      {session && (
        <>
          <p className="text-sm text-muted-foreground">
            Les annotations rejoignent le dossier avec « Enregistrer le dossier ». Tu peux aussi
            préciser une cible et son comportement dans les champs d’annotation.
          </p>
          <div className="h-[600px] min-w-0">
            <PreviewPanel
              mode="embedded"
              {...session}
              visible
              onCaptureAnnotation={onCaptureAnnotation}
            />
          </div>
        </>
      )}
    </section>
  );
}

function TaskAgreements({
  chantier,
  task,
  disabled,
  execute,
}: {
  chantier: WorkChantier;
  task: WorkTask;
  disabled: boolean;
  execute: Execute;
}) {
  const review = chantier.v2!.reviews.find((r) => r.taskId === task.id);
  const [kind, setKind] = useState<"code" | "other">(review?.kind ?? "code");
  const [pm, setPm] = useState(review?.pmReference ?? "");
  const [url, setUrl] = useState(review?.pullRequestUrl ?? "");
  const [head, setHead] = useState(review?.head ?? "");
  const [environment, setEnvironment] = useState("");
  const [evidence, setEvidence] = useState(review?.completionEvidence ?? "");
  const identity = {
    id: chantier.id,
    expectedVersion: chantier.version,
    taskId: task.id,
    expectedTaskVersion: task.version,
  };
  return (
    <fieldset disabled={disabled} className="space-y-2 border-t pt-3">
      <legend className="text-sm font-medium">
        {task.title} · {task.status}
      </legend>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Type de travail"
          className="rounded border bg-background p-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="code">Code avec PR</option>
          <option value="other">Autre travail</option>
        </select>
        <Input
          aria-label="Ticket de suivi collectif"
          placeholder="Ticket PM (facultatif)"
          value={pm}
          onChange={(e) => setPm(e.target.value)}
        />
        <Button
          variant="outline"
          onClick={() => void execute({ ...identity, type: "approveTask", kind, pmReference: pm })}
        >
          Approuver cette tâche
        </Button>
      </div>
      {review?.approvedDefinition && task.status !== "done" && (
        <div className="space-y-2">
          <label className="block text-sm">
            Résultat et vérification des critères
            <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <Button
            variant="outline"
            disabled={!evidence.trim()}
            onClick={() => void execute({ ...identity, type: "completeTask", evidence })}
          >
            Confirmer la tâche terminée
          </Button>
        </div>
      )}
      {review?.completionEvidence && (
        <p className="text-sm">Résultat : {review.completionEvidence}</p>
      )}
      {kind === "code" && (
        <details>
          <summary className="cursor-pointer text-sm">PR, accords et déploiement</summary>
          <div className="space-y-2 py-2">
            <Input
              aria-label="Adresse de la PR"
              placeholder="Adresse de la PR"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              aria-label="Révision du code"
              placeholder="SHA du dernier code"
              value={head}
              onChange={(e) => setHead(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => void execute({ ...identity, type: "pullRequest", url, head })}
            >
              Raccorder la PR vérifiée
            </Button>
            {review?.head && (
              <>
                <p className="text-sm">
                  Valentin : {review.humanHead === review.head ? "accord" : "à valider"} · Chef :{" "}
                  {review.chefHead === review.head ? "accord" : "à valider"} ·{" "}
                  {review.mergedHead ? "Merge vérifié" : "Merge en attente"}
                </p>
                <Button
                  onClick={() => void execute({ ...identity, type: "humanReview", approved: true })}
                >
                  J’approuve le merge de ce code
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void execute({ ...identity, type: "humanReview", approved: false })
                  }
                >
                  Retirer mon accord
                </Button>
              </>
            )}
            <Input
              aria-label="Environnement de déploiement"
              placeholder="Environnement choisi"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => void execute({ ...identity, type: "deploymentGo", environment })}
            >
              Donner le go de déploiement
            </Button>
            {review?.retainedHumanApproval && (
              <p className="text-sm">Accord conservé : {review.retainedHumanApproval}</p>
            )}
          </div>
        </details>
      )}
    </fieldset>
  );
}

function ProjectPolicy({
  environmentId,
  chantier,
}: {
  environmentId: EnvironmentId;
  chantier: WorkChantier;
}) {
  const query = useEnvironmentQuery(
    chantierProjectPolicy({ environmentId, input: { projectId: chantier.projectId } }),
  );
  return query.data ? (
    <PolicyForm
      key={query.data.expectedVersion}
      environmentId={environmentId}
      initial={query.data}
    />
  ) : (
    <p>Chargement des habitudes du projet…</p>
  );
}
function PolicyForm({
  environmentId,
  initial,
}: {
  environmentId: EnvironmentId;
  initial: ChantierProjectPolicy;
}) {
  const [draft, setDraft] = useState(initial);
  const [result, setResult] = useState("");
  const save = useAtomCommand(saveChantierProjectPolicy);
  const allowed = useAtomValue(saveChantierProjectPolicy.permissionAtom(environmentId));
  return (
    <form
      className="space-y-3 rounded-xl border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ environmentId, input: draft }).then((r) => {
          if (r._tag === "Failure") setResult(String(squashAtomCommandFailure(r)));
          else {
            setDraft(r.value);
            setResult("Habitudes enregistrées.");
          }
        });
      }}
    >
      <fieldset disabled={!allowed} className="space-y-3">
        <legend className="font-medium">Habitudes communes au projet</legend>
        <label className="block text-sm">
          Tâches actives au maximum
          <Input
            type="number"
            min={1}
            max={20}
            value={draft.maxParallel}
            onChange={(e) => setDraft({ ...draft, maxParallel: Number(e.target.value) })}
          />
        </label>
        <label className="block text-sm">
          Contrôle de secours par défaut (secondes)
          <Input
            type="number"
            min={30}
            max={86400}
            value={draft.intervalSeconds}
            onChange={(e) => setDraft({ ...draft, intervalSeconds: Number(e.target.value) })}
          />
        </label>
        {(
          [
            ["trackingHabits", "Suivi collectif"],
            ["sourceRules", "Sources et routines"],
            ["delegations", "Délégations précises (aucun droit implicite)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="block text-sm">
            {label}
            <Textarea
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="block text-sm">
          Environnements possibles (un par ligne)
          <Textarea
            value={draft.deploymentEnvironments.join("\n")}
            onChange={(e) =>
              setDraft({
                ...draft,
                deploymentEnvironments: e.target.value.split("\n").filter(Boolean),
              })
            }
          />
        </label>
        <Button type="submit">Enregistrer pour le projet</Button>
        <p role="status">{result}</p>
      </fieldset>
    </form>
  );
}
