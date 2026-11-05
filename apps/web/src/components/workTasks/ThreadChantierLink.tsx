import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { workChantiers, workTasks } from "../../state/workTasks";

export function ThreadChantierLink({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const chantiers = useEnvironmentQuery(workChantiers({ environmentId, input: {} })).data ?? [];
  const tasks = useEnvironmentQuery(workTasks({ environmentId, input: {} })).data ?? [];
  const linked = chantiers.filter(
    (c) =>
      c.orchestratorThreadId === threadId ||
      tasks.some((t) => t.agentThreadId === threadId && t.chantierId === c.id),
  );
  if (!linked.length) return null;
  return (
    <div className="flex flex-wrap gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
      {linked.map((c) => (
        <Link
          key={c.id}
          to="/tasks"
          search={{
            tab: "chantiers",
            chantier: c.id,
            environment: environmentId,
            view: "discussion",
          }}
          className="hover:text-primary"
        >
          {c.orchestratorThreadId === threadId ? "Orchestrateur" : "Revenir à l’orchestrateur"} ·{" "}
          {c.title}
        </Link>
      ))}
    </div>
  );
}
