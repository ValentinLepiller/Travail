import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { slackTaskFilters } from "../../state/workTasks";
import collectorScript from "../../../../server/scripts/collect-slack-tasks.ts?raw";
import collectorService from "../../../../server/src/workTasks/SlackTaskCollector.ts?raw";
import { CollectionAutomationDetail } from "./CollectionAutomationDetail";

const sources = {
  script: { path: "apps/server/scripts/collect-slack-tasks.ts", code: collectorScript },
  service: { path: "apps/server/src/workTasks/SlackTaskCollector.ts", code: collectorService },
};

export default function SlackAutomationDetail({
  environmentId,
  onClose,
}: {
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const filters = useEnvironmentQuery(slackTaskFilters({ environmentId, input: {} }));
  return (
    <CollectionAutomationDetail name="Slack" sources={sources} onClose={onClose}>
      <section className="space-y-2 text-sm" aria-label="Channels exclus">
        <h3 className="font-medium">Channels exclus de la collecte</h3>
        {filters.error ? (
          <p role="alert">Impossible de charger les exclusions de cette machine.</p>
        ) : !filters.data ? (
          <p>Chargement des exclusions…</p>
        ) : !filters.data.configured ? (
          <p>La collecte Slack n’est pas configurée sur cette machine.</p>
        ) : filters.data.excludeChannelNames.length === 0 ? (
          <p>Aucun channel exclu.</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Les messages de ces channels sont ignorés et ne créent aucune tâche.
            </p>
            <ul className="list-inside list-disc">
              {[...new Set(filters.data.excludeChannelNames)].map((name) => (
                <li key={name}>#{name.replace(/^#/, "")}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </CollectionAutomationDetail>
  );
}
