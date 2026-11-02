import { lazy, Suspense, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { BotIcon, CircleDashedIcon, PauseIcon, PlayIcon } from "lucide-react";
import {
  type AutonomousAgent,
  AutonomousAgentConfig,
  type AutonomousAgentCommand,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  autonomousAgents,
  autonomousAgentDetail,
  commandAutonomousAgent,
} from "../../state/autonomousAgents";
import { workTasks } from "../../state/workTasks";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { AgentThreadMessages } from "./AgentThreadMessages";

const decodeTrigger = Schema.decodeUnknownSync(AutonomousAgentConfig.fields.trigger);
const CardPosition = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const initialGmailPosition = { x: 16, y: 150 };
const initialSlackPosition = { x: 16, y: 16 };

const GmailAutomationDetail = lazy(() => import("./GmailAutomationDetail"));
const SlackAutomationDetail = lazy(() => import("./SlackAutomationDetail"));

const states = {
  idle: "En attente",
  working: "En cours",
  paused: "En pause",
  blocked: "À reprendre",
  finishing: "Enregistrement terminé",
};
export function AutonomousAgentsPage() {
  const selection = useEnvironmentSelection();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <BotIcon className="size-4" />
        <h1 className="text-sm font-medium">Automatisations</h1>
      </WorkspacePageHeader>
      {selection.environments.length > 1 && (
        <label className="p-3">
          Machine{" "}
          <select
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
        </label>
      )}
      {selection.environmentId ? (
        <Canvas key={selection.environmentId} environmentId={selection.environmentId} />
      ) : (
        <p className="p-6">Connecte une machine pour retrouver ses agents.</p>
      )}
    </SidebarInset>
  );
}
function Canvas({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(autonomousAgents({ environmentId, input: {} }));
  const tasks = useEnvironmentQuery(workTasks({ environmentId, input: {} }));
  const [selected, setSelected] = useState<
    { kind: "agent"; id: string } | { kind: "slack" } | { kind: "gmail" } | null
  >(null);
  const [editing, setEditing] = useState(false);
  const [gmailPosition, setGmailPosition] = useLocalStorage(
    `automation-gmail-position:${environmentId}`,
    initialGmailPosition,
    CardPosition,
  );
  const [slackPosition, setSlackPosition] = useLocalStorage(
    `automation-slack-position:${environmentId}`,
    initialSlackPosition,
    CardPosition,
  );
  const [form, setForm] = useState<AutonomousAgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const command = useAtomCommand(commandAutonomousAgent);
  const allowed = useAtomValuePermission(environmentId);
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
  const agent = query.data?.find((a) => selected?.kind === "agent" && a.id === selected.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Button variant="outline" disabled={!allowed || busy} onClick={() => setEditing(!editing)}>
          {editing ? "Terminer l’affichage" : "Modifier l’affichage"}
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="p-3 text-destructive">
          {error ?? query.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-h-64 flex-1 overflow-auto bg-muted/20">
          <div
            className="relative min-h-full min-w-full"
            style={{
              width: Math.max(
                850,
                slackPosition.x + 280,
                gmailPosition.x + 280,
                ...(query.data ?? []).map((a) => a.x + 280),
              ),
              height: Math.max(
                600,
                slackPosition.y + 180,
                gmailPosition.y + 180,
                ...(query.data ?? []).map((a) => a.y + 180),
              ),
            }}
          >
            <CollectionCard
              title="Messages Slack"
              position={slackPosition}
              selected={selected?.kind === "slack"}
              editing={editing}
              onSelect={() => setSelected({ kind: "slack" })}
              onMove={setSlackPosition}
            />
            <CollectionCard
              title="Messages Gmail"
              position={gmailPosition}
              selected={selected?.kind === "gmail"}
              editing={editing}
              onSelect={() => setSelected({ kind: "gmail" })}
              onMove={setGmailPosition}
            />
            {!query.data?.length && (
              <p className="pointer-events-none absolute left-4 top-72 text-muted-foreground">
                Les agents créés à ta demande apparaîtront ici.
              </p>
            )}
            {query.data?.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                selected={selected?.kind === "agent" && selected.id === a.id}
                editing={editing}
                busy={busy || !allowed}
                count={
                  a.trigger !== "interval"
                    ? (tasks.data?.filter(
                        (t) =>
                          t.status === a.trigger &&
                          (a.projectId === null || t.projectId === a.projectId),
                      ).length ?? 0)
                    : undefined
                }
                onSelect={() => setSelected({ kind: "agent", id: a.id })}
                onPause={() =>
                  void execute({
                    type: a.paused || a.status === "blocked" ? "resume" : "pause",
                    id: a.id,
                  })
                }
                onMove={(x, y) => void execute({ type: "save", config: { ...a, x, y } })}
              />
            ))}
          </div>
        </div>
        {selected?.kind === "gmail" && (
          <aside
            aria-label="Automatisation Gmail"
            className="min-h-0 w-full shrink-0 overflow-auto border-l p-4 lg:w-[min(50%,700px)]"
          >
            <Suspense fallback={<p>Chargement du script…</p>}>
              <GmailAutomationDetail onClose={() => setSelected(null)} />
            </Suspense>
          </aside>
        )}
        {selected?.kind === "slack" && (
          <aside
            aria-label="Automatisation Slack"
            className="min-h-0 w-full shrink-0 overflow-auto border-l p-4 lg:w-[min(50%,700px)]"
          >
            <Suspense fallback={<p>Chargement du script…</p>}>
              <SlackAutomationDetail
                environmentId={environmentId}
                onClose={() => setSelected(null)}
              />
            </Suspense>
          </aside>
        )}
        {agent && (
          <div className="w-full shrink-0 overflow-y-auto border-l p-4 lg:w-[420px]">
            <Detail
              key={agent.id}
              agent={agent}
              environmentId={environmentId}
              busy={busy || !allowed}
              execute={execute}
              onEdit={() => setForm(agent)}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
      {form && (
        <div className="absolute inset-0 z-30 overflow-auto bg-background/95 p-6">
          <AgentForm
            initial={form}
            environmentId={environmentId}
            busy={busy}
            onCancel={() => setForm(null)}
            onSave={async (config) => {
              if (await execute({ type: "save", config })) {
                setForm(null);
                setSelected({ kind: "agent", id: config.id });
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
function CollectionCard({
  title,
  position,
  selected,
  editing,
  onSelect,
  onMove,
}: {
  title: string;
  position: { readonly x: number; readonly y: number };
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onMove: (position: { x: number; y: number }) => void;
}) {
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; position: { x: number; y: number } } | null>(null);
  return (
    <button
      type="button"
      aria-label={`${editing ? "Déplacer" : "Ouvrir"} ${title}`}
      aria-pressed={selected}
      onClick={() => {
        if (!editing) onSelect();
      }}
      onPointerDown={(e) => {
        if (!editing || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          x: e.clientX - position.x,
          y: e.clientY - position.y,
          position: { ...position },
        };
      }}
      onPointerMove={(e) => {
        if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const next = {
          x: Math.max(0, Math.min(4000, e.clientX - drag.current.x)),
          y: Math.max(0, Math.min(4000, e.clientY - drag.current.y)),
        };
        drag.current.position = next;
        setPreview(next);
      }}
      onPointerUp={(e) => {
        if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        onMove(drag.current.position);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setPreview(null);
      }}
      className={cn(
        "absolute block w-60 rounded-xl border bg-card p-3 text-left shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        editing && "touch-none select-none cursor-move",
        selected && "ring-2 ring-inset ring-primary",
      )}
      style={{ left: preview?.x ?? position.x, top: preview?.y ?? position.y }}
    >
      <span className="block font-medium">{title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">
        Collecte vers les tâches à qualifier
      </span>
      <span className="mt-3 block text-xs text-muted-foreground">
        {editing ? "Glisser pour déplacer" : "Voir le script →"}
      </span>
    </button>
  );
}
import { useAtomValue } from "@effect/atom-react";
function useAtomValuePermission(environmentId: EnvironmentId) {
  return useAtomValue(commandAutonomousAgent.permissionAtom(environmentId));
}
function AgentCard({
  agent,
  selected,
  editing,
  busy,
  count,
  onSelect,
  onPause,
  onMove,
}: {
  agent: AutonomousAgent;
  selected: boolean;
  editing: boolean;
  busy: boolean;
  count?: number | undefined;
  onSelect: () => void;
  onPause: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const isWorking = agent.status === "working" && !agent.paused;
  const canResume = agent.paused || agent.status === "blocked";
  return (
    <div
      className={cn(
        "absolute w-60 rounded-xl border bg-card p-3 shadow-sm",
        isWorking && "border-info",
        selected && "ring-2",
        selected && (isWorking ? "ring-info/30" : "ring-primary"),
      )}
      style={{ left: position?.x ?? agent.x, top: position?.y ?? agent.y }}
    >
      <button
        type="button"
        aria-label={`Ouvrir ${agent.name}`}
        disabled={editing}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
        onClick={onSelect}
      />
      <div className="absolute right-2 top-2">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          aria-label={canResume ? "Reprendre" : "Pause"}
          title={canResume ? "Reprendre" : "Pause"}
          onClick={onPause}
        >
          {canResume ? <PlayIcon /> : <PauseIcon />}
        </Button>
      </div>
      <div
        className={cn(
          "relative mr-8 flex touch-none items-center gap-2 text-left font-medium",
          editing ? "cursor-move" : "pointer-events-none",
        )}
        onPointerDown={(e) => {
          if (!editing || busy) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.dragX = String(e.clientX - agent.x);
          e.currentTarget.dataset.dragY = String(e.clientY - agent.y);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setPosition({
              x: Math.max(0, Math.min(4000, e.clientX - Number(e.currentTarget.dataset.dragX))),
              y: Math.max(0, Math.min(4000, e.clientY - Number(e.currentTarget.dataset.dragY))),
            });
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
            if (position) onMove(position.x, position.y);
            setPosition(null);
          }
        }}
        onPointerCancel={() => setPosition(null)}
      >
        {isWorking ? (
          <CircleDashedIcon
            role="status"
            aria-label={states.working}
            ref={observeVisibleAnimation}
            className="size-4 shrink-0 text-info motion-safe:visible-animate-spin"
          />
        ) : (
          <BotIcon aria-hidden className="size-4" />
        )}
        {agent.name}
      </div>
      {!isWorking && (
        <p className="pointer-events-none relative mt-2 text-xs text-muted-foreground">
          {states[agent.status]}
        </p>
      )}
      {count !== undefined && (
        <p className="pointer-events-none relative mt-2 text-xs">
          {count} à qualifier → {agent.name}
        </p>
      )}
      {agent.error && (
        <p className="pointer-events-none relative mt-2 text-xs text-destructive">{agent.error}</p>
      )}
    </div>
  );
}
function Detail({
  agent,
  environmentId,
  busy,
  execute,
  onEdit,
  onClose,
}: {
  agent: AutonomousAgent;
  environmentId: EnvironmentId;
  busy: boolean;
  execute: (input: AutonomousAgentCommand) => Promise<boolean>;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<ThreadId | undefined>();
  const [tab, setTab] = useState("thread");
  const [memory, setMemory] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    autonomousAgentDetail({
      environmentId,
      input: { id: agent.id, ...(threadId ? { threadId } : {}) },
    }),
  );
  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <strong>{agent.name}</strong>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Fermer
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {[
          ["thread", "Thread"],
          ["waiting", "En attente"],
          ["history", "Historique"],
          ["memory", "Mémoire"],
        ].map(([id, label]) => (
          <Button
            key={id}
            size="sm"
            variant={tab === id ? "secondary" : "ghost"}
            onClick={() => setTab(id!)}
          >
            {label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          Règles
        </Button>
      </div>
      {query.error && <p role="alert">{query.error}</p>}
      {tab === "thread" && (
        <>
          <p className="text-xs text-muted-foreground">
            {threadId
              ? query.data?.history.find((r) => r.threadId === threadId)?.waitingFor
                ? "En attente d’une réponse"
                : "Thread historique"
              : states[agent.status]}{" "}
            · {query.data?.pending ?? 0} échange(s) en attente
          </p>
          <Button variant="outline" size="sm" onClick={() => setThreadId(undefined)}>
            Thread actuel
          </Button>
          <AgentThreadMessages
            messages={query.data?.messages ?? []}
            environmentId={environmentId}
            threadId={threadId ?? agent.currentThreadId ?? undefined}
            agentName={agent.name}
          />
        </>
      )}
      {(tab === "history" || tab === "waiting") &&
        query.data?.history
          .filter((r) => (tab === "waiting" ? r.waitingFor !== null : r.finishedAt !== null))
          .map((r) => (
            <div key={r.threadId} className="space-y-2 rounded border p-3">
              <button
                className="text-left text-sm"
                onClick={() => {
                  setThreadId(r.threadId);
                  setTab("thread");
                }}
              >
                {r.title}
                <span className="block text-xs text-muted-foreground">
                  {r.startedAt} ·{" "}
                  {r.waitingFor === "human"
                    ? "Attend ton arbitrage"
                    : r.waitingFor === "agent"
                      ? "Attend un autre agent"
                      : "Archivé"}
                </span>
              </button>
              {r.finishedAt && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void execute({ type: "export", id: agent.id, threadId: r.threadId })
                  }
                >
                  Continuer dans Discussions
                </Button>
              )}
            </div>
          ))}
      {tab === "memory" && (
        <>
          <p className="break-all text-xs text-muted-foreground">{query.data?.memoryPath}</p>
          <Textarea
            aria-label="Mémoire durable"
            value={memory ?? query.data?.memory ?? ""}
            onChange={(e) => setMemory(e.target.value)}
            rows={18}
          />
          <Button
            disabled={busy || memory === null}
            onClick={async () => {
              if (memory !== null && (await execute({ type: "memory", id: agent.id, memory })))
                setMemory(null);
            }}
          >
            Enregistrer la mémoire
          </Button>
        </>
      )}
    </div>
  );
}
function AgentForm({
  initial,
  environmentId,
  busy,
  onCancel,
  onSave,
}: {
  initial: AutonomousAgentConfig;
  environmentId: EnvironmentId;
  busy: boolean;
  onCancel: () => void;
  onSave: (value: AutonomousAgentConfig) => Promise<void>;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const servers = useServerConfigs();
  const providers = servers.get(environmentId)?.providers ?? [];
  const [draft, setDraft] = useState(initial);
  const provider = providers.find((p) => p.instanceId === draft.modelSelection.instanceId);
  return (
    <form
      className="mx-auto max-w-xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft);
      }}
    >
      <h2 className="font-medium">Règles de l’agent</h2>
      <label className="block">
        Nom
        <Input
          required
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="block">
        Portée
        <select
          className="block w-full rounded border bg-background p-2"
          value={draft.projectId ?? ""}
          onChange={(e) => {
            if (!e.target.value) {
              setDraft({ ...draft, projectId: null });
              return;
            }
            const project = projects.find((p) => p.id === e.target.value);
            if (project) setDraft({ ...draft, projectId: project.id });
          }}
        >
          <option value="">Tous les projets — sans projet</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Fournisseur
        <select
          className="block w-full rounded border bg-background p-2"
          value={draft.modelSelection.instanceId}
          onChange={(e) => {
            const p = providers.find((p) => p.instanceId === e.target.value);
            if (p)
              setDraft({
                ...draft,
                modelSelection: { instanceId: p.instanceId, model: p.models[0]?.slug ?? "" },
              });
          }}
        >
          {providers.map((p) => (
            <option key={p.instanceId} value={p.instanceId}>
              {p.displayName ?? p.instanceId}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Modèle
        <select
          className="block w-full rounded border bg-background p-2"
          value={draft.modelSelection.model}
          onChange={(e) =>
            setDraft({
              ...draft,
              modelSelection: { ...draft.modelSelection, model: e.target.value },
            })
          }
        >
          {provider?.models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Déclencheur
        <select
          className="block w-full rounded border bg-background p-2"
          value={draft.trigger}
          onChange={(e) =>
            setDraft({
              ...draft,
              trigger: decodeTrigger(e.target.value),
            })
          }
        >
          <option value="unqualified">Une tâche à qualifier est disponible</option>
          <option value="todo">Une tâche à préparer est disponible</option>
          <option value="interval">À chaque intervalle</option>
        </select>
      </label>
      {draft.dailySchedule && draft.trigger === "interval" ? (
        <p>
          Chaque jour à {draft.dailySchedule.timeOfDay} ({draft.dailySchedule.timeZone}). La reprise
          lance un passage immédiat.
        </p>
      ) : (
        <label className="block">
          Intervalle (secondes)
          <Input
            type="number"
            min={30}
            max={86400}
            required
            value={draft.intervalSeconds}
            onChange={(e) => setDraft({ ...draft, intervalSeconds: Number(e.target.value) })}
          />
        </label>
      )}
      <label className="block">
        Mission et périmètre
        <Textarea
          rows={9}
          required
          value={draft.mission}
          onChange={(e) => setDraft({ ...draft, mission: e.target.value })}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Priorité : tes décisions → échanges entre agents → travail ordinaire. La personnalité se
        modifie dans sa mémoire.
      </p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !draft.modelSelection.model}>
          Enregistrer
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
