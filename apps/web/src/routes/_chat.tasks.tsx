import { createFileRoute } from "@tanstack/react-router";
import { WorkTasksPage } from "../components/workTasks/WorkTasksPage";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: "tasks" | "chantiers";
    chantier?: string | undefined;
    environment?: string | undefined;
    view?: "discussion" | "tasks" | "tree" | "context";
    task?: string | undefined;
  } => ({
    tab: search.tab === "chantiers" ? "chantiers" : "tasks",
    environment: typeof search.environment === "string" ? search.environment : undefined,
    chantier: typeof search.chantier === "string" ? search.chantier : undefined,
    view:
      search.view === "tasks" || search.view === "tree" || search.view === "context"
        ? search.view
        : "discussion",
    task: typeof search.task === "string" ? search.task : undefined,
  }),
  component: WorkTasksPage,
});
