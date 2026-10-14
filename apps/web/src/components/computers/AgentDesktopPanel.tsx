import { mapViewerPointToScreen } from "@t3tools/shared/computerView";
import { useRef, useState, type MouseEvent } from "react";

import { Button } from "../ui/button";

import type { AgentDesktopSnapshot, AgentDesktopInput } from "@t3tools/contracts";

type Props = {
  initialSnapshot: AgentDesktopSnapshot;
  canControl?: boolean;
  refresh: () => Promise<AgentDesktopSnapshot>;
  transfer: (
    target: { sessionId: string; revision: number },
    controller: "agent" | "human",
  ) => Promise<unknown>;
  input: (input: AgentDesktopInput) => Promise<unknown>;
  close: (target: { sessionId: string; revision: number }) => Promise<unknown>;
  onClosed: () => void;
};

/** Mount keyed by leaseId so a newly selected desktop starts with its own snapshot. */
export function AgentDesktopPanel({
  initialSnapshot,
  canControl = true,
  refresh,
  transfer,
  input,
  close,
  onClosed,
}: Props) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [windowId, setWindowId] = useState(initialSnapshot.windows[0]?.id ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const human = snapshot.status.controller === "human";
  const target = { sessionId: snapshot.status.sessionId, revision: snapshot.status.revision };
  const currentWindow =
    snapshot.windows.find((window) => window.id === windowId) ?? snapshot.windows[0];

  const run = async (action?: () => Promise<unknown>, closing = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action?.();
      if (closing) onClosed();
      else setSnapshot(await refresh());
    } catch {
      setError("Action refusée ou session indisponible. Actualisez le bureau avant de réessayer.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const send = (
    action:
      | { kind: "type"; text: string }
      | { kind: "key"; key: string }
      | { kind: "click"; x: number; y: number },
  ) => {
    if (!canControl || !human || !currentWindow) return;
    void run(() => input({ ...target, windowId: currentWindow.id, ...action }));
  };
  const click = (event: MouseEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = mapViewerPointToScreen({
      clientX: event.clientX,
      clientY: event.clientY,
      elementLeft: bounds.left,
      elementTop: bounds.top,
      elementWidth: bounds.width,
      elementHeight: bounds.height,
      imageWidth: snapshot.status.width,
      imageHeight: snapshot.status.height,
      screenX: 0,
      screenY: 0,
      screenWidth: snapshot.status.width,
      screenHeight: snapshot.status.height,
    });
    if (point) send({ kind: "click", ...point });
  };

  return (
    <section aria-label="Bureau privé de l’agent" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {human
            ? "Vous contrôlez ce bureau. Les actions de l’agent sur ce bureau sont suspendues."
            : "L’agent contrôle ce bureau."}
        </span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
          Actualiser
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canControl}
          onClick={() => void run(() => transfer(target, human ? "agent" : "human"))}
        >
          {human ? "Rendre la main à l’agent" : "Prendre la main"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canControl || !human}
          onClick={() => void run(() => close(target), true)}
        >
          Fermer la session
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="overflow-auto rounded border bg-black">
        <img
          src={`data:${snapshot.screenshot.mimeType};base64,${snapshot.screenshot.data}`}
          width={snapshot.status.width}
          height={snapshot.status.height}
          alt="Capture du bureau isolé de cet agent"
          className="block h-auto max-w-full"
          onClick={click}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label>
          Fenêtre{" "}
          <select
            aria-label="Fenêtre"
            value={currentWindow?.id ?? ""}
            disabled={busy || !canControl || !human || !currentWindow}
            onChange={(event) => setWindowId(event.target.value)}
          >
            {snapshot.windows.map((window) => (
              <option key={window.id} value={window.id}>
                {window.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Texte{" "}
          <input
            value={text}
            maxLength={4096}
            disabled={busy || !canControl || !human || !currentWindow}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canControl || !human || !currentWindow || !text}
          onClick={() => send({ kind: "type", text })}
        >
          Saisir
        </Button>
        {["Return", "Tab", "Escape", "BackSpace", "ctrl+c"].map((key) => (
          <Button
            key={key}
            variant="outline"
            size="sm"
            disabled={busy || !canControl || !human || !currentWindow}
            onClick={() => send({ kind: "key", key })}
          >
            {key}
          </Button>
        ))}
      </div>
    </section>
  );
}
