import { useStore } from "zustand";
import { requestPageState } from "../../state/workPageState";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useProject, useThreadShell } from "../../state/entities";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { AgentRequest, AgentRequestRespond, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BotIcon, InboxIcon, XIcon } from "lucide-react";
import { useWorkPageEnvironmentSelection } from "../../hooks/useWorkPageEnvironmentSelection";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { agentRequests, respondToRequest, retryRequestDelivery } from "../../state/agentRequests";
import { isElectron } from "../../env";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { requestQueue } from "./requestQueue";
import ChatMarkdown from "../ChatMarkdown";
import { useResizableWidth } from "../../hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

const ChatView = lazy(() => import("../ChatView"));

export const statusLabels: Record<AgentRequest["status"], string> = {
  pending: "À traiter",
  revision: "Modification demandée",
  accepted: "Acceptée",
  rejected: "Refusée",
  answered: "Répondue",
  withdrawn: "Retirée",
  ignored: "Ignorée",
};
const actionLabels: Record<AgentRequest["actionStatus"], string> = {
  idle: "En attente d’exécution",
  running: "Exécution en cours",
  succeeded: "Action réussie",
  failed: "Action échouée",
  uncertain: "Exécution interrompue : résultat à vérifier",
};
function useRequestProject(request: AgentRequest | null | undefined, environmentId: EnvironmentId) {
  const thread = useThreadShell(request ? scopeThreadRef(environmentId, request.threadId) : null);
  return useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
}

function RequestProject({ project }: { project: ProjectFaviconProject | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      {project ? <ProjectFavicon project={project} className="size-4 shrink-0" /> : null}
      <span className="truncate">{project?.title ?? "Projet indisponible"}</span>
    </span>
  );
}

function RequestQueueProject({
  request,
  environmentId,
}: {
  request: AgentRequest;
  environmentId: EnvironmentId;
}) {
  const project = useRequestProject(request, environmentId);
  return request.autonomousAgent ? (
    <RequestAgent request={request} />
  ) : (
    <RequestProject project={project} />
  );
}

function RequestAgent({ request }: { request: AgentRequest }) {
  return (
    <span className="inline-flex self-start items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
      <BotIcon className="size-4 shrink-0" />
      {request.autonomousAgent?.name}
    </span>
  );
}

function requestTitle(request: AgentRequest) {
  const decision = request.qualification?.decision;
  return `${decision ? (decision === "reject" ? "❌ " : "✅ ") : ""}${request.question}`;
}

export function AgentRequestsPage() {
  const { environments, isReady, environmentId, setEnvironmentId } =
    useWorkPageEnvironmentSelection("requests");
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <InboxIcon className="size-4" />
        <h1 className="text-sm font-medium">Requêtes</h1>
      </WorkspacePageHeader>
      {environments.length > 1 && (
        <div className="p-3">
          <label>
            Machine{" "}
            <select
              value={environmentId ?? ""}
              onChange={(e) =>
                setEnvironmentId(
                  environments.find((x) => x.environmentId === e.target.value)?.environmentId ??
                    null,
                )
              }
            >
              {environments.map((x) => (
                <option key={x.environmentId} value={x.environmentId}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {environmentId ? (
        <RequestInbox key={environmentId} environmentId={environmentId} />
      ) : (
        <p className="p-6">
          {isReady
            ? "Aucun serveur enregistré dans les connexions de Travail."
            : "Chargement des connexions…"}
        </p>
      )}
    </SidebarInset>
  );
}
function RequestInbox({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(agentRequests({ environmentId, input: {} }));
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const page = requestPageState(environmentId);
  const archive = useStore(page, (state) => state.archive);
  const selected = useStore(page, (state) => state.selected);
  const requests = query.data ?? [];
  const { pendingCount, visible, current } = requestQueue(requests, archive, selected);
  useEffect(() => {
    if (query.data !== null && current?.id && current.id !== selected) {
      page.setState({ selected: current.id });
    }
  }, [current?.id, page, query.data, selected]);
  const project = useRequestProject(current, environmentId);
  const projectColor = project
    ? (project.projectIcon?.color ?? deriveProjectIdentity(project.title).color)
    : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2 border-b p-3">
        <Button
          variant={archive ? "ghost" : "secondary"}
          onClick={() => {
            page.setState({ archive: false, selected: null });
          }}
        >
          À traiter ({pendingCount})
        </Button>
        <Button
          variant={archive ? "secondary" : "ghost"}
          onClick={() => {
            page.setState({ archive: true, selected: null });
          }}
        >
          Archives ({requests.length - pendingCount})
        </Button>
      </div>
      {query.error && (
        <p role="alert" className="p-4 text-destructive">
          {query.error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="File des requêtes"
          className="max-h-48 shrink-0 overflow-y-auto border-b md:max-h-none md:w-72 md:border-r md:border-b-0"
        >
          {visible.map((request) => (
            <button
              key={request.id}
              aria-current={current?.id === request.id ? "true" : undefined}
              onClick={() => page.setState({ selected: request.id })}
              className={`w-full border-b p-4 text-left text-sm hover:bg-muted ${current?.id === request.id ? "bg-muted" : ""}`}
            >
              <RequestQueueProject request={request} environmentId={environmentId} />
              <span className="mt-2 block font-medium">{requestTitle(request)}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {request.qualification?.source ??
                  request.autonomousAgent?.source ??
                  request.context}
              </span>
              {archive && (
                <span className="mt-2 block text-xs">
                  {statusLabels[request.status]}
                  {request.delivery === "failed" ? " · Transmission échouée" : ""}
                  {request.actionStatus === "failed" || request.actionStatus === "uncertain"
                    ? " · Action à vérifier"
                    : ""}
                </span>
              )}
            </button>
          ))}
        </nav>
        <main
          className="scrollbar-gutter-both min-w-0 flex-1 overflow-y-auto p-5 md:p-10"
          style={
            projectColor
              ? {
                  backgroundColor: `color-mix(in oklab, var(--color-${projectColor}-500) 5%, var(--project-surface-base))`,
                }
              : undefined
          }
        >
          {current ? (
            <RequestCard
              key={`${current.id}:${current.version}`}
              request={current}
              environmentId={environmentId}
              project={project}
              onOpenDiscussion={() => setDiscussionOpen(true)}
            />
          ) : (
            <div className="mx-auto max-w-xl py-20 text-center text-muted-foreground">
              <InboxIcon className="mx-auto mb-4 size-10" />
              <p>
                {query.data === null && !query.error
                  ? "Chargement…"
                  : archive
                    ? "Aucune requête archivée."
                    : "Tout est traité. Les prochaines requêtes apparaîtront ici."}
              </p>
            </div>
          )}
        </main>
        {discussionOpen && current && (
          <RequestDiscussion
            key={current.threadId}
            request={current}
            environmentId={environmentId}
            onClose={() => setDiscussionOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
function RequestDiscussion({
  request,
  environmentId,
  onClose,
}: {
  request: AgentRequest;
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const thread = useThreadShell(scopeThreadRef(environmentId, request.threadId));
  const { width, handlers } = useResizableWidth({
    storageKey: "requests-discussion-width",
    defaultWidth: 640,
    minWidth: 360,
    maxWidth: 1200,
    edge: "left",
  });
  return (
    <aside
      aria-label="Discussion de la requête"
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col border-l bg-background xl:relative xl:inset-auto xl:w-(--resizable-width) xl:max-w-[60%] xl:shrink-0"
      style={{ "--resizable-width": `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={handlers} className="hidden xl:block" />
      <div className="flex shrink-0 items-center justify-between gap-3 border-b p-3">
        <span className="truncate text-sm font-medium">{thread?.title ?? "Discussion"}</span>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: request.threadId }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Ouvrir la discussion
          </Link>
          <Button variant="ghost" size="icon" aria-label="Fermer la discussion" onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>
      {thread && !thread.deletedAt ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 [transform:translate(0)]">
          <Suspense
            fallback={
              <p className="p-4 text-sm text-muted-foreground">Chargement de la discussion…</p>
            }
          >
            <ChatView
              environmentId={environmentId}
              threadId={request.threadId}
              routeKind="server"
              reserveTitleBarControlInset={false}
            />
          </Suspense>
        </div>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Cette discussion est indisponible.
        </p>
      )}
    </aside>
  );
}

export function RequestCard({
  request,
  environmentId,
  project,
  inline = false,
  onOpenDiscussion,
}: {
  request: AgentRequest;
  environmentId: EnvironmentId;
  project?: ProjectFaviconProject | null;
  inline?: boolean;
  onOpenDiscussion?: () => void;
}) {
  const compact = request.autonomousAgent?.qualifier === true && request.action?.kind !== "command";
  const source = request.qualification?.source ?? request.autonomousAgent?.source;
  const page = requestPageState(environmentId);
  const draft = useStore(page, (state) => state.drafts[request.id]);
  const text = draft?.version === request.version ? draft.text : "";
  const setText = (text: string) => {
    page.setState((state) => ({
      drafts: { ...state.drafts, [request.id]: { version: request.version, text } },
    }));
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRespond = useAtomValue(respondToRequest.permissionAtom(environmentId));
  const canRetry = useAtomValue(retryRequestDelivery.permissionAtom(environmentId));
  const respond = useAtomCommand(respondToRequest);
  const retry = useAtomCommand(retryRequestDelivery);
  const submit = async (decision: AgentRequestRespond["decision"]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await respond({
        environmentId,
        input: { id: request.id, expectedVersion: request.version, decision, text },
      });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
      } else {
        page.setState((state) => {
          const draft = state.drafts[request.id];
          if (draft?.version !== request.version || draft.text !== text) return state;
          const { [request.id]: _, ...drafts } = state.drafts;
          return { drafts };
        });
      }
    } finally {
      setBusy(false);
    }
  };
  const technicalDetails = (
    <>
      {request.details && (
        <ChatMarkdown
          text={request.details}
          cwd={undefined}
          environmentId={environmentId}
          threadRef={{ environmentId, threadId: request.threadId }}
        />
      )}
      {request.action && (
        <section className="rounded-xl border bg-muted/30 p-4">
          <h3 className="mb-2 text-sm font-medium">À l’acceptation</h3>
          {request.action.kind === "agent" ? (
            <p className="text-sm">
              L’agent recevra ton accord : {request.action.instruction}
              {request.status === "accepted" && (
                <span className="mt-2 block">
                  {request.actionStatus === "idle"
                    ? "Résultat attendu de l’agent"
                    : actionLabels[request.actionStatus]}
                </span>
              )}
            </p>
          ) : (
            <>
              <p className="text-sm">{request.action.label}</p>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs">
                {JSON.stringify([request.action.executable, ...request.action.args], null, 2)}
                {"\n"}Dossier : {request.action.cwd}
              </pre>
              {request.status === "accepted" && (
                <p role="status" className="mt-3 text-sm">
                  {actionLabels[request.actionStatus]}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-6">
      {!inline &&
        (request.autonomousAgent ? (
          <RequestAgent request={request} />
        ) : (
          <RequestProject project={project ?? null} />
        ))}
      <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
        <span>{statusLabels[request.status]}</span>
        {!inline &&
          (onOpenDiscussion ? (
            <Button variant="ghost" onClick={onOpenDiscussion}>
              Voir la discussion
            </Button>
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: request.threadId }}
            >
              Voir la discussion
            </Link>
          ))}
      </div>
      <div>
        {source && <p className="mb-3 text-sm text-muted-foreground">{source}</p>}
        <p className="mb-3 text-muted-foreground">{request.context}</p>
        <h2 className="text-2xl font-semibold">{requestTitle(request)}</h2>
      </div>
      {compact && (request.details || request.action) ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Voir les détails
          </summary>
          <div className="mt-4 flex flex-col gap-4">{technicalDetails}</div>
        </details>
      ) : (
        technicalDetails
      )}
      {compact && request.status === "accepted" && request.action && (
        <p role="status" className="text-sm text-muted-foreground">
          {request.actionStatus === "idle"
            ? "Résultat attendu de l’agent"
            : actionLabels[request.actionStatus]}
        </p>
      )}
      {request.status === "pending" && (
        <div className="flex flex-col gap-3">
          <Textarea
            aria-label={
              request.kind === "text" ? "Ta réponse" : "Commentaire ou modification demandée"
            }
            placeholder={
              request.kind === "text"
                ? "Ta réponse…"
                : "Un commentaire, une alternative ou une modification…"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {request.kind === "approval" ? (
              <Button disabled={busy || !canRespond} onClick={() => void submit("accept")}>
                {request.action?.kind === "command"
                  ? `Accepter et ${request.action.label}`
                  : "Accepter la requête"}
              </Button>
            ) : (
              <Button
                disabled={busy || !canRespond || !text.trim()}
                onClick={() => void submit("answer")}
              >
                Envoyer la réponse
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy || !canRespond}
              onClick={() => void submit("reject")}
            >
              Refuser
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !canRespond || !text.trim()}
              onClick={() => void submit("revise")}
            >
              Demander une modification
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !canRespond}
              onClick={() => void submit("ignore")}
              title="Archiver sans envoyer de réponse à l’agent"
            >
              Ignorer
            </Button>
          </div>
        </div>
      )}
      {request.status !== "pending" && request.response && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Ta réponse</h3>
          <p className="whitespace-pre-wrap text-sm">{request.response}</p>
        </section>
      )}
      {request.delivery === "pending" && (
        <p role="status" className="text-sm text-muted-foreground">
          Transmission à l’agent en cours…
        </p>
      )}
      {request.delivery === "failed" && (
        <div role="alert">
          <p>La réponse est enregistrée, mais sa transmission à l’agent a échoué.</p>
          <Button
            variant="outline"
            disabled={busy || !canRetry}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await retry({
                  environmentId,
                  input: { id: request.id, expectedVersion: request.version },
                });
                if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
              } finally {
                setBusy(false);
              }
            }}
          >
            Retransmettre la réponse
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {request.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Historique des réponses
          </summary>
          {request.history.map((item) => (
            <p key={`${item.at}:${item.text}`} className="mt-3 whitespace-pre-wrap text-sm">
              {new Date(item.at).toLocaleString()} — {item.text}
            </p>
          ))}
        </details>
      )}
    </article>
  );
}
