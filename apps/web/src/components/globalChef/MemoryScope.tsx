import type { ChefMemoryDraft, EnvironmentId } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { workChantiers } from "../../state/workTasks";

export const memoryScopeLabels = {
  global: "Globale",
  project: "Projet",
  chantier: "Chantier",
  sender: "Expéditeur",
};
export const memoryActionLabels = {
  create: "Créer une tâche",
  complete: "Compléter une tâche",
  ignore: "Ignorer le sujet",
  handoff: "Transmettre au Chef responsable",
};
export function MemoryScope({
  scope,
  environmentId,
}: {
  scope: ChefMemoryDraft["scope"];
  environmentId: EnvironmentId;
}) {
  const projects = useProjects();
  const chantiers = useEnvironmentQuery(
    scope.kind === "chantier" ? workChantiers({ environmentId, input: {} }) : null,
  );
  let label: string;
  switch (scope.kind) {
    case "global":
      label = "Tous les contextes";
      break;
    case "project":
      label =
        projects.find((p) => p.environmentId === environmentId && p.id === scope.id)?.title ??
        "Projet indisponible";
      break;
    case "chantier":
      label = chantiers.data?.find((c) => c.id === scope.id)?.title ?? "Chantier indisponible";
      break;
    case "sender":
      label = scope.id?.startsWith("gmail:")
        ? scope.id.slice(6)
        : "Contact Slack indiqué dans la source";
      break;
  }
  return (
    <span>
      {memoryScopeLabels[scope.kind]} · {label}
    </span>
  );
}
