import { WorkTaskError, type WorkTaskSaveInput, type WorkChantier } from "@t3tools/contracts";

/** Validate the final graph, including forward references in an atomic plan. */
export function validateTaskDependencies(
  tasks: ReadonlyArray<WorkTaskSaveInput>,
  chantiers: ReadonlyArray<WorkChantier>,
): WorkTaskError | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chantierById = new Map(chantiers.map((chantier) => [chantier.id, chantier]));
  for (const task of tasks) {
    const chantier = task.chantierId ? chantierById.get(task.chantierId) : null;
    if (task.chantierId && (!chantier || chantier.projectId !== task.projectId))
      return new WorkTaskError({ reason: "project" });
    if (
      new Set(task.dependsOn).size !== (task.dependsOn?.length ?? 0) ||
      new Set(task.externalDependsOn).size !== (task.externalDependsOn?.length ?? 0)
    )
      return new WorkTaskError({ reason: "dependencies" });
    for (const id of task.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (!dependency || !chantier || dependency.chantierId !== task.chantierId)
        return new WorkTaskError({ reason: "dependencies" });
    }
    if (
      task.externalDependsOn?.some(
        (id) => !chantier?.externalDependencies.some((item) => item.id === id),
      )
    )
      return new WorkTaskError({ reason: "dependencies" });
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)?.dependsOn?.some(cycle)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => cycle(task.id)) ? new WorkTaskError({ reason: "cycle" }) : null;
}
