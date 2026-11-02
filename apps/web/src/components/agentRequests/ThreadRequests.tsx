import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { agentRequests } from "../../state/agentRequests";
import { useEnvironmentQuery } from "../../state/query";
import { RequestCard, statusLabels } from "./AgentRequestsPage";

export function ThreadRequests({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(agentRequests({ environmentId, input: {} }));
  const requests = query.data?.filter((request) => request.threadId === threadId) ?? [];
  if (!requests.length && !query.error) return null;
  const pendingCount = requests.filter((request) => request.status === "pending").length;
  return (
    <details className="text-left">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
        Requêtes ({requests.length})
        {pendingCount > 0 && <span className="ml-2 text-primary">{pendingCount} à traiter</span>}
      </summary>
      <div className="flex max-h-[min(45dvh,28rem)] flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-3">
        {query.error && (
          <p role="alert" className="text-sm text-destructive">
            {query.error}
          </p>
        )}
        {requests.map((request) => (
          <details key={request.id} className="rounded-xl border bg-muted/20 p-4">
            <summary className="cursor-pointer text-sm">
              <span className="font-medium">Requête · {statusLabels[request.status]}</span>
              <span className="mt-1 block text-muted-foreground">{request.question}</span>
            </summary>
            <div className="mt-4">
              <RequestCard
                key={`${request.id}:${request.version}`}
                request={request}
                environmentId={environmentId}
                inline
              />
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
