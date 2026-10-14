import {
  AuthTerminalOperateScope,
  type AgentDesktopLease,
  type AgentDesktopSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPopup,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { AgentDesktopPanel } from "./AgentDesktopPanel";
import { makeAgentDesktopClient } from "./agentDesktopApi";

type Props = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadTitle: string;
  onClose: () => void;
};

/** Mount keyed by environment/thread so late responses cannot cross into another task. */
export function AgentDesktopDialog({ environmentId, threadId, threadTitle, onClose }: Props) {
  const client = useMemo(
    () => makeAgentDesktopClient(environmentId, threadId),
    [environmentId, threadId],
  );
  const canControl = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [leases, setLeases] = useState<readonly AgentDesktopLease[]>([]);
  const [selected, setSelected] = useState<string>();
  const [snapshot, setSnapshot] = useState<AgentDesktopSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const reload = useCallback(
    async (preferred?: string) => {
      const revision = ++generation.current;
      try {
        const next = await client.list();
        if (revision !== generation.current) return;
        const leaseId = next.some((lease) => lease.leaseId === preferred)
          ? preferred
          : next[0]?.leaseId;
        setLeases(next);
        setSelected(leaseId);
        const capture = leaseId ? await client.capture(leaseId) : undefined;
        if (revision === generation.current) {
          setSnapshot(capture);
          setError(undefined);
        }
      } catch {
        if (revision === generation.current)
          setError("Impossible de consulter les bureaux de cette tâche.");
      } finally {
        if (revision === generation.current) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- All state updates follow an awaited destination request.
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const select = (leaseId?: string) => {
    setLoading(true);
    setSnapshot(undefined);
    setError(undefined);
    void reload(leaseId);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup variant="media">
        <div className="flex max-h-[90vh] w-[min(90vw,1280px)] min-w-0 flex-col rounded-xl border bg-background text-foreground">
          <DialogHeader>
            <DialogTitle>Bureaux de {threadTitle}</DialogTitle>
            <DialogDescription>
              Voir le bureau privé d’un agent et prendre explicitement la main.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-wrap items-center gap-2">
              <label>
                Bureau{" "}
                <select
                  aria-label="Bureau"
                  value={selected ?? ""}
                  onChange={(event) => select(event.target.value)}
                  disabled={loading || leases.length === 0}
                >
                  {leases.map((lease, index) => (
                    <option key={lease.leaseId} value={lease.leaseId}>
                      Bureau {index + 1} ·{" "}
                      {lease.status.controller === "human" ? "contrôle humain" : "contrôle agent"}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => select(selected)}
              >
                Actualiser la liste
              </Button>
            </div>
            {loading && <p role="status">Chargement du bureau…</p>}
            {error && <p role="alert">{error}</p>}
            {!loading && !error && leases.length === 0 && (
              <p>
                Aucun bureau ouvert. L’agent crée son bureau lorsqu’il a besoin d’une application
                graphique.
              </p>
            )}
            {snapshot && selected && (
              <AgentDesktopPanel
                key={selected}
                initialSnapshot={snapshot}
                canControl={canControl}
                refresh={async () => {
                  const value = await client.capture(selected);
                  setLeases((previous) =>
                    previous.map((lease) =>
                      lease.leaseId === selected ? { ...lease, status: value.status } : lease,
                    ),
                  );
                  return value;
                }}
                transfer={(target, controller) =>
                  client.act(selected, {
                    action: controller === "human" ? "take" : "release",
                    target,
                  })
                }
                input={(input) => client.act(selected, { action: "input", input })}
                close={(target) => client.act(selected, { action: "close", target })}
                onClosed={() => {
                  select();
                }}
              />
            )}
          </DialogPanel>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
