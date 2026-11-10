import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ChefHatIcon, MailIcon, MailOpenIcon, PauseIcon, PlayIcon, SendIcon } from "lucide-react";
import type { AutonomousAgent, AutonomousAgentCommand, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  autonomousAgents,
  autonomousAgentDetail,
  commandAutonomousAgent,
} from "../../state/autonomousAgents";
import { RequestCard } from "../agentRequests/AgentRequestsPage";
import { agentRequests } from "../../state/agentRequests";
import { isElectron } from "../../env";
import { randomUUID, cn } from "../../lib/utils";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const states = {
  idle: "Veille",
  working: "Au travail",
  paused: "En pause",
  blocked: "À reprendre",
  finishing: "Fin du passage",
};

export function ChefsPage() {
  const selection = useEnvironmentSelection();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <ChefHatIcon className="size-4" />
        <h1 className="text-sm font-medium">Chefs</h1>
        {selection.environments.length > 1 && (
          <select
            aria-label="Machine"
            value={selection.environmentId ?? ""}
            onChange={(e) =>
              selection.setEnvironmentId(
                selection.environments.find((x) => x.environmentId === e.target.value)
                  ?.environmentId ?? null,
              )
            }
          >
            {selection.environments.map((e) => (
              <option key={e.environmentId} value={e.environmentId}>
                {e.label}
              </option>
            ))}
          </select>
        )}
      </WorkspacePageHeader>
      {selection.environmentId ? (
        <ChefList key={selection.environmentId} environmentId={selection.environmentId} />
      ) : (
        <p className="p-6">Connecte une machine pour retrouver ses Chefs.</p>
      )}
    </SidebarInset>
  );
}

function ChefList({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(autonomousAgents({ environmentId, input: {} }));
  const chefs = query.data?.filter((a) => a.kind === "chef") ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const chef = chefs.find((a) => a.id === selected) ?? chefs[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        aria-label="Chefs des projets"
        className="flex shrink-0 gap-2 overflow-auto border-b p-3 md:w-64 md:flex-col md:border-r md:border-b-0"
      >
        {chefs.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelected(a.id)}
            aria-pressed={chef?.id === a.id}
            className={cn(
              "shrink-0 rounded-xl p-3 text-left hover:bg-muted",
              chef?.id === a.id && "bg-muted",
            )}
          >
            <span className="flex items-center justify-between gap-2 text-sm font-medium">
              {a.name}
              {(a.unreadCount ?? 0) > 0 && (
                <span
                  className="rounded-full bg-primary px-2 text-xs text-primary-foreground"
                  aria-label={`${a.unreadCount} message(s) non lu(s)`}
                >
                  {a.unreadCount}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{states[a.status]}</span>
          </button>
        ))}
        {query.error && <p role="alert">{query.error}</p>}
        {!query.data && !query.error && <p>Chargement…</p>}
        {query.data && !chef && (
          <p className="text-sm text-muted-foreground">Aucun Chef sur cette machine.</p>
        )}
      </aside>
      {chef && <ChefConversation key={chef.id} agent={chef} environmentId={environmentId} />}
    </div>
  );
}

export function ChefConversation({
  agent,
  environmentId,
}: {
  agent: AutonomousAgent;
  environmentId: EnvironmentId;
}) {
  const detail = useEnvironmentQuery(
    autonomousAgentDetail({ environmentId, input: { id: agent.id } }),
  );
  const requests = useEnvironmentQuery(agentRequests({ environmentId, input: {} }));
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const allowed = useAtomValue(commandAutonomousAgent.permissionAtom(environmentId));
  const command = useAtomCommand(commandAutonomousAgent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState<{ text: string; id: string } | null>(null);
  const [settings, setSettings] = useState(false);
  const [suppressRead, setSuppressRead] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const lastReadAttempt = useRef<string | null>(null);
  const lastChefMessageId = detail.data?.chat?.findLast(
    (message) => message.role === "assistant",
  )?.id;
  const unreadCount = agent.unreadCount ?? 0;
  const [mission, setMission] = useState<string | null>(null);
  const [interval, setInterval] = useState<number | null>(null);
  const [wakeOnTaskChanges, setWakeOnTaskChanges] = useState<boolean | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const ownThreads = new Set(detail.data?.history.map((run) => run.threadId));
  const pending =
    requests.data?.filter(
      (r) => ownThreads.has(r.threadId) && ["pending", "revision"].includes(r.status),
    ) ?? [];
  const execute = async (input: AutonomousAgentCommand) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (
      settings ||
      suppressRead ||
      !atBottom ||
      !allowed ||
      unreadCount === 0 ||
      !lastChefMessageId
    )
      return;
    const markVisibleRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        lastReadAttempt.current === lastChefMessageId
      )
        return;
      lastReadAttempt.current = lastChefMessageId;
      void command({
        environmentId,
        input: { type: "read", id: agent.id, messageId: lastChefMessageId },
      }).then((result) => {
        if (result._tag === "Failure" && lastReadAttempt.current === lastChefMessageId) {
          lastReadAttempt.current = null;
          setError(String(squashAtomCommandFailure(result)));
        }
      });
    };
    markVisibleRead();
    window.addEventListener("focus", markVisibleRead);
    document.addEventListener("visibilitychange", markVisibleRead);
    return () => {
      window.removeEventListener("focus", markVisibleRead);
      document.removeEventListener("visibilitychange", markVisibleRead);
    };
  }, [
    agent.id,
    allowed,
    atBottom,
    command,
    environmentId,
    lastChefMessageId,
    settings,
    suppressRead,
    unreadCount,
  ]);
  return (
    <section
      aria-label={`Messagerie ${agent.name}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-medium">{agent.name}</h2>
          <p className="text-xs text-muted-foreground">
            {states[agent.status]} ·{" "}
            {projects.find((p) => p.id === agent.projectId)?.title ?? "Projet à choisir"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={unreadCount > 0 ? "Marquer comme lu" : "Marquer comme non lu"}
            title={unreadCount > 0 ? "Marquer comme lu" : "Marquer comme non lu"}
            disabled={busy || !allowed || !lastChefMessageId}
            onClick={() => {
              if (!lastChefMessageId) return;
              const unread = unreadCount === 0;
              setSuppressRead(unread);
              void execute({
                type: unread ? "unread" : "read",
                id: agent.id,
                messageId: lastChefMessageId,
              }).then((ok) => {
                if (!ok) setSuppressRead(!unread);
              });
            }}
          >
            {unreadCount > 0 ? <MailOpenIcon /> : <MailIcon />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !allowed || !agent.projectId}
            onClick={() =>
              void execute({
                type: agent.paused || agent.status === "blocked" ? "resume" : "pause",
                id: agent.id,
              })
            }
          >
            {agent.paused || agent.status === "blocked" ? <PlayIcon /> : <PauseIcon />}
            {agent.kind === "chantier-chef"
              ? agent.paused || agent.status === "blocked"
                ? "Réveiller le Chef"
                : "Mettre le Chef en veille"
              : agent.paused || agent.status === "blocked"
                ? "Démarrer"
                : "Pause"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSettings(!settings);
              if (settings) setAtBottom(true);
            }}
          >
            {settings ? "Messages" : "Règles et mémoire"}
          </Button>
        </div>
      </header>
      {(error || detail.error || agent.error) && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error ?? detail.error ?? agent.error}
        </p>
      )}
      {settings ? (
        <div className="space-y-4 overflow-auto p-4">
          <label className="block text-sm">
            Projet
            <select
              aria-label="Projet du Chef"
              className="mt-1 block w-full rounded border bg-background p-2"
              value={agent.projectId ?? ""}
              disabled={busy || !allowed || !agent.paused || agent.currentThreadId !== null}
              onChange={(e) => {
                const project = projects.find((p) => p.id === e.target.value);
                if (project)
                  void execute({ type: "save", config: { ...agent, projectId: project.id } });
              }}
            >
              <option value="">Choisir un projet</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.workspaceRoot}
                </option>
              ))}
            </select>
          </label>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void execute({
                type: "save",
                config: {
                  ...agent,
                  mission: mission ?? agent.mission,
                  intervalSeconds: interval ?? agent.intervalSeconds,
                  wakeOnTaskChanges: wakeOnTaskChanges ?? agent.wakeOnTaskChanges ?? true,
                },
              }).then((ok) => {
                if (ok) {
                  setMission(null);
                  setInterval(null);
                  setWakeOnTaskChanges(null);
                }
              });
            }}
          >
            <label className="block text-sm">
              Règles
              <Textarea
                aria-label="Règles du Chef"
                rows={5}
                value={mission ?? agent.mission}
                onChange={(e) => setMission(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm">
              Contrôle de secours (secondes)
              <Input
                type="number"
                min={30}
                max={86400}
                required
                value={interval ?? agent.intervalSeconds}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={wakeOnTaskChanges ?? agent.wakeOnTaskChanges ?? true}
                onChange={(e) => setWakeOnTaskChanges(e.target.checked)}
              />
              Réagir aux changements des tâches
            </label>
            <Button type="submit" size="sm" disabled={busy || !allowed}>
              Enregistrer les règles
            </Button>
          </form>
          <label className="block text-sm">
            Mémoire
            <Textarea
              aria-label="Mémoire du Chef"
              rows={8}
              value={memory ?? detail.data?.memory ?? ""}
              onChange={(e) => setMemory(e.target.value)}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !allowed || memory === null}
            onClick={() => {
              if (memory !== null)
                void execute({ type: "memory", id: agent.id, memory }).then((ok) => {
                  if (ok) setMemory(null);
                });
            }}
          >
            Enregistrer la mémoire
          </Button>
          <p className="text-xs text-muted-foreground">
            GPT-6.1 Sol · High · Réagit aux changements des tâches et vérifie périodiquement les
            attentes.
          </p>
        </div>
      ) : (
        <>
          <div
            className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto scrollbar-gutter-both p-4"
            onScroll={(event) => setAtBottom(Math.abs(event.currentTarget.scrollTop) < 16)}
          >
            <div
              aria-live="polite"
              aria-label="Messages avec le Chef"
              className="mx-auto w-full max-w-3xl space-y-4"
            >
              {!detail.data?.chat?.length && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Explique au Chef comment faire avancer ce projet. Il apprendra au fil des
                  échanges.
                </p>
              )}
              {detail.data?.chat?.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    "max-w-[90%] rounded-2xl p-3",
                    message.role === "user"
                      ? "ml-auto bg-message text-message-foreground"
                      : "mr-auto bg-muted",
                  )}
                >
                  <p className="mb-1 text-xs text-muted-foreground">
                    {message.role === "user" ? "Toi" : agent.name}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                </article>
              ))}
              {pending.map((request) => (
                <div key={request.id} className="rounded-xl border p-3">
                  <RequestCard request={request} environmentId={environmentId} inline />
                </div>
              ))}
            </div>
          </div>
          <form
            className="border-t p-4"
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text || busy || !allowed) return;
              const message =
                pendingMessage?.text === text ? pendingMessage : { text, id: randomUUID() };
              setPendingMessage(message);
              void execute({ type: "message", id: agent.id, messageId: message.id, text }).then(
                (ok) => {
                  if (ok) {
                    setDraft("");
                    setPendingMessage(null);
                  }
                },
              );
            }}
          >
            {agent.paused && (
              <p className="mb-2 text-xs text-muted-foreground">
                En pause : les messages seront lus au démarrage du Chef.
              </p>
            )}
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <div className="min-w-0 flex-1">
                <Textarea
                  aria-label="Message au Chef"
                  placeholder="Un court message au Chef…"
                  rows={2}
                  maxLength={5000}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter" ||
                      event.shiftKey ||
                      event.altKey ||
                      event.metaKey ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    )
                      return;
                    event.preventDefault();
                    if (event.ctrlKey) {
                      const input = event.currentTarget;
                      if (
                        input.value.length - (input.selectionEnd - input.selectionStart) <
                        input.maxLength
                      ) {
                        input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
                        setDraft(input.value);
                      }
                      return;
                    }
                    if (!event.repeat) event.currentTarget.form?.requestSubmit();
                  }}
                  disabled={busy || !allowed}
                />
              </div>
              <Button
                type="submit"
                size="icon"
                aria-label="Envoyer au Chef"
                disabled={busy || !allowed || !draft.trim()}
              >
                <SendIcon />
              </Button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
