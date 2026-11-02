import { workTaskBlockers, type WorkTask, type WorkChantier } from "@t3tools/contracts";
import { useState } from "react";
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
  const [zoom, setZoom] = useState(1);
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
  const counts = new Map<number, number>();
  const nodes = [
    ...chantier.externalDependencies
      .filter((e) => tasks.some((t) => t.externalDependsOn?.includes(e.id)))
      .map((e) => ({
        id: `external:${e.id}`,
        title: e.title,
        status: e.done ? "Livré" : `Attendu · ${e.owner || "Autre équipe"}`,
        level: 0,
        external: true,
      })),
    ...tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status:
        t.status === "done"
          ? "Terminée"
          : t.status === "doing"
            ? "En cours"
            : t.status === "review"
              ? "À valider"
              : workTaskBlockers(t, tasks, chantier.externalDependencies).length
                ? "En attente"
                : t.status === "ready"
                  ? "À démarrer"
                  : t.status === "rejected"
                    ? "Refusée"
                    : t.status === "merged"
                      ? "Fusionnée"
                      : "À préparer",
      level: levels.get(t.id) ?? 0,
      external: false,
    })),
  ].map((node) => {
    const column = counts.get(node.level) ?? 0;
    counts.set(node.level, column + 1);
    return { ...node, x: 24 + column * 270, y: 24 + node.level * 154 };
  });
  const positions = new Map(nodes.map((node) => [node.id, node]));
  const width = Math.max(560, ...nodes.map((node) => node.x + 260));
  const height = Math.max(320, ...nodes.map((node) => node.y + 125));
  const edges = tasks.flatMap((t) =>
    [...(t.dependsOn ?? []), ...(t.externalDependsOn ?? []).map((id) => `external:${id}`)].map(
      (from) => ({ from, to: t.id }),
    ),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Flèche : prérequis → tâche</span>
        <Button variant="outline" size="sm" onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}>
          −
        </Button>
        <span>{Math.round(zoom * 100)} %</span>
        <Button variant="outline" size="sm" onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}>
          +
        </Button>
      </div>
      {!tasks.length ? (
        <p className="p-6 text-sm text-muted-foreground">
          L’orchestrateur peut préparer le découpage dans la discussion du chantier.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div
            className="overflow-auto rounded-xl border bg-card"
            aria-label="Arbre des dépendances"
          >
            <div style={{ width: width * zoom, height: height * zoom }}>
              <div
                className="relative origin-top-left"
                style={{ width, height, transform: `scale(${zoom})` }}
              >
                <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
                  <defs>
                    <marker
                      id="chantier-arrow"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {edges.map(({ from, to }) => {
                    const a = positions.get(from),
                      b = positions.get(to);
                    if (!a || !b) return null;
                    return (
                      <path
                        key={`${from}:${to}`}
                        d={`M ${a.x + 120} ${a.y + 100} C ${a.x + 120} ${a.y + 128}, ${b.x + 120} ${b.y - 28}, ${b.x + 120} ${b.y}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeDasharray={a.external ? "5 4" : undefined}
                        markerEnd="url(#chantier-arrow)"
                        className="text-muted-foreground"
                      />
                    );
                  })}
                </svg>
                {nodes.map((node) => (
                  <button
                    key={node.id}
                    disabled={node.external}
                    onClick={() => setSelected(node.id)}
                    className={`absolute flex h-[100px] w-[240px] flex-col justify-center gap-2 rounded-xl border bg-background p-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${node.external ? "border-dashed" : "hover:border-primary"} ${selected === node.id ? "border-primary ring-1 ring-primary" : ""}`}
                    style={{ left: node.x, top: node.y }}
                  >
                    <span className="line-clamp-2 font-medium">{node.title}</span>
                    <span className="text-xs text-muted-foreground">{node.status}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <aside className="space-y-4 rounded-xl border bg-card p-4">
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
                    {workTaskBlockers(task, tasks, chantier.externalDependencies).map(
                      (title, i) => (
                        <li key={i}>{title}</li>
                      ),
                    )}
                  </ul>
                  {!workTaskBlockers(task, tasks, chantier.externalDependencies).length && (
                    <p>Aucun prérequis en attente.</p>
                  )}
                </div>
                <div className="text-sm">
                  <strong>Débloque</strong>
                  {tasks
                    .filter((t) => t.dependsOn?.includes(task.id))
                    .map((t) => (
                      <p key={t.id}>{t.title}</p>
                    ))}
                </div>
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
