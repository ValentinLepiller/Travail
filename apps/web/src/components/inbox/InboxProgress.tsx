import { useMemo } from "react";
import type {
  EnvironmentId,
  InboxQualificationStatus,
  InboxGroupingStatus,
} from "@t3tools/contracts";
import { inboxGroupingProgress, inboxQualificationProgress } from "../../state/inboxProgress";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";

function qualificationLabel(
  status: typeof InboxQualificationStatus.Type | null,
  error: string | null,
) {
  if (error) return "Statut indisponible";
  if (!status) return "Vérification…";
  if (!status.enabled) return "En pause";
  if (status.errors) return "Réessai en attente";
  if (status.head?.state === "waiting_context") return "En attente du contexte";
  return status.remaining ? `${status.remaining} à qualifier` : "À jour";
}
function groupingLabel(status: typeof InboxGroupingStatus.Type | null, error: string | null) {
  if (error) return "Statut indisponible";
  if (!status) return "Vérification…";
  if (!status.enabled) return "En pause";
  if (status.errors || status.contextErrors) return "Réessai en attente";
  if (status.remaining) return `${status.remaining} à regrouper`;
  if (status.waitingJev) return "En attente de Jev";
  return status.contextsPending ? `${status.contextsPending} contextes à identifier` : "À jour";
}

export function InboxProgress({ environmentId }: { environmentId: EnvironmentId }) {
  const target = useMemo(() => ({ environmentId, input: {} }), [environmentId]);
  const jev = useEnvironmentQuery(inboxQualificationProgress(target));
  const luna = useEnvironmentQuery(inboxGroupingProgress(target));
  const j = jev.data,
    l = luna.data;
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2" aria-label="Avancement Inbox">
      <Badge
        variant={
          jev.error || j?.errors || j?.head?.state === "waiting_context"
            ? "warning"
            : j?.enabled && j.remaining === 0
              ? "success"
              : "secondary"
        }
        shape="pill"
      >
        Jev · {qualificationLabel(j, jev.error)}
      </Badge>
      <Badge
        variant={
          luna.error || l?.errors || l?.contextErrors
            ? "warning"
            : l?.enabled && l.remaining === 0 && l.waitingJev === 0 && !l.contextsPending
              ? "success"
              : "secondary"
        }
        shape="pill"
      >
        Luna · {groupingLabel(l, luna.error)}
      </Badge>
      {l?.enabled && l.remaining > 0 && l.waitingJev > 0 ? (
        <span className="text-xs text-muted-foreground">{l.waitingJev} après Jev</span>
      ) : null}
    </div>
  );
}
