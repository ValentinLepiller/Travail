import { CheckCircle2Icon, Clock3Icon } from "lucide-react";
import { STATUS_LABELS, STATUS_PRESENTATION } from "./workTaskPresentation";
import { workTaskBlockers, type WorkTask, type WorkChantier } from "@t3tools/contracts";
import { type CSSProperties, useState } from "react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

export function WorkDependencyTree({
  chantier,
  tasks,
  onOpenTask,
  onDiscuss,
}: {
  chantier: WorkChantier;
  tasks: ReadonlyArray<WorkTask>;
  onOpenTask: (id: string) => void;
  onDiscuss: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const task = tasks.find((t) => t.id === selected);
  const levels = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = (id: string, visiting = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const item = byId.get(id);
    const rank = Math.max(
      0,
      ...(item?.dependsOn ?? []).map((parent) => depth(parent, visiting) + 1),
      item?.externalDependsOn?.length ? 1 : 0,
    );
    visiting.delete(id);
    levels.set(id, rank);
    return rank;
  };
  tasks.forEach((t) => depth(t.id));
  const stages = [...new Set(levels.values())].sort((a, b) => a - b);
  const blockers = task ? workTaskBlockers(task, tasks, chantier.externalDependencies) : [];
  const dependents = tasks.filter((t) => t.dependsOn?.includes(task?.id ?? ""));
  const external = chantier.externalDependencies.filter((e) =>
    tasks.some((t) => t.externalDependsOn?.includes(e.id)),
  );
  return (
    <div className="space-y-3">
      {!tasks.length ? (
        <p className="p-6 text-sm text-muted-foreground">
          L’orchestrateur peut préparer le découpage dans la discussion du chantier.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0 space-y-6" aria-label="Arbre des dépendances">
            <p className="text-sm text-muted-foreground">
              De haut en bas, chaque étape suit ses prérequis. Les tâches d’une même étape peuvent
              avancer en parallèle.
            </p>
            {external.length > 0 && (
              <section className="space-y-3 rounded-xl border border-dashed p-4">
                <h3 className="text-sm font-medium">Attentes externes</h3>
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {external.map((e) => (
                    <div
                      key={e.id}
                      className={`rounded-lg border p-3 text-sm ${e.done ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10"}`}
                    >
                      <p className="font-medium">{e.title}</p>
                      <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        {e.done ? (
                          <CheckCircle2Icon className="size-3.5" />
                        ) : (
                          <Clock3Icon className="size-3.5" />
                        )}
                        {e.done ? "Livré" : `Attendu · ${e.owner || "Autre équipe"}`}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <ol className="ml-3 space-y-6 border-l-2 border-border">
              {stages.map((level, index) => {
                const items = tasks.filter((t) => levels.get(t.id) === level);
                return (
                  <li key={level} className="relative pl-6">
                    <span className="absolute -left-3.5 top-0 flex size-7 items-center justify-center rounded-full border bg-background text-xs font-semibold">
                      {index + 1}
                    </span>
                    <h3 className="mb-3 text-sm font-medium">
                      Étape {index + 1} · {items.length} tâches
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                      {items.map((item) => {
                        const waiting = workTaskBlockers(
                          item,
                          tasks,
                          chantier.externalDependencies,
                        );
                        const blocked =
                          waiting.length > 0 &&
                          !["done", "merged", "rejected", "doing", "review"].includes(item.status);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-pressed={selected === item.id}
                            onClick={() => setSelected(item.id)}
                            style={
                              {
                                "--task-color": STATUS_PRESENTATION[item.status].color,
                                backgroundColor:
                                  "color-mix(in srgb, var(--task-color) 10%, var(--background))",
                                borderColor:
                                  "color-mix(in srgb, var(--task-color) 45%, var(--border))",
                              } as CSSProperties
                            }
                            className={`flex min-w-0 flex-col gap-3 rounded-xl border p-4 text-left text-sm outline-none hover:ring-1 hover:ring-inset hover:ring-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected === item.id ? "ring-2 ring-inset ring-primary" : ""}`}
                          >
                            <span className="break-words font-medium">{item.title}</span>
                            <span className="flex items-center gap-2 text-xs">
                              <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: "var(--task-color)" }}
                              />
                              {STATUS_LABELS[item.status]}
                            </span>
                            {blocked && (
                              <span className="text-xs text-muted-foreground">
                                {waiting.length} prérequis en attente
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <aside className="h-fit space-y-4 rounded-xl border bg-card p-4 xl:sticky xl:top-4">
            {task ? (
              <>
                <h3 className="font-medium">{task.title}</h3>
                <Badge variant="secondary">Cadre · {chantier.title}</Badge>
                <p className="whitespace-pre-wrap text-sm">
                  {task.acceptanceCriteria ||
                    task.notes ||
                    "Résultat à préciser avec l’orchestrateur."}
                </p>
                <div className="text-sm">
                  <strong>Attend</strong>
                  <ul className="mt-2 list-inside list-disc">
                    {blockers.map((title, i) => (
                      <li key={i}>{title}</li>
                    ))}
                  </ul>
                  {!blockers.length && <p>Aucun prérequis en attente.</p>}
                </div>
                <div className="text-sm">
                  <strong>Débloque</strong>
                  {dependents.map((t) => (
                    <p key={t.id}>{t.title}</p>
                  ))}
                </div>
                {!dependents.length && (
                  <p className="text-sm text-muted-foreground">Aucune tâche suivante.</p>
                )}
                <Button variant="outline" onClick={() => onOpenTask(task.id)}>
                  Détails de la tâche
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sélectionne une tâche pour voir ses prérequis et son résultat attendu.
              </p>
            )}
            <Button variant="outline" onClick={onDiscuss}>
              Parler à l’orchestrateur
            </Button>
          </aside>
        </div>
      )}
    </div>
  );
}
