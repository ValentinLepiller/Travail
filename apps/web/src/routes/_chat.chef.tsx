import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import GlobalChefPage from "../components/globalChef/GlobalChefPage";

export const Route = createFileRoute("/_chat/chef")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { environment?: EnvironmentId; dossier?: string } => ({
    ...(typeof search.environment === "string" && search.environment.length <= 200
      ? { environment: EnvironmentId.make(search.environment) }
      : {}),
    ...(typeof search.dossier === "string" && search.dossier.length <= 500
      ? { dossier: search.dossier }
      : {}),
  }),
  component: ChefRoute,
});
function ChefRoute() {
  const search = Route.useSearch();
  return <GlobalChefPage environmentId={search.environment} dossierId={search.dossier} />;
}
