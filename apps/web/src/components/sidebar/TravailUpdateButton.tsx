import {
  AuthEnvironmentMaintainScope,
  TravailUpdateStatus,
  type TravailUpdateRequest,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { useEnvironmentSelection } from "../../hooks/useEnvironmentSelection";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const decodeStatus = Schema.decodeUnknownSync(Schema.NullOr(TravailUpdateStatus));
const label = "Installer les mises à jour";

export function TravailUpdateButton({ className }: { className?: string }) {
  const { environmentId } = useEnvironmentSelection();
  const mayMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const token =
    connection?.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
  const baseUrl =
    mayMaintain && connection?.httpAuthorization?._tag !== "Dpop"
      ? connection?.httpBaseUrl
      : undefined;
  return baseUrl ? (
    <ConnectedTravailUpdateButton
      key={baseUrl}
      baseUrl={baseUrl}
      token={token}
      className={className}
    />
  ) : null;
}

function ConnectedTravailUpdateButton({
  baseUrl,
  token,
  className,
}: {
  baseUrl: string;
  token: string | null;
  className?: string | undefined;
}) {
  const [status, setStatus] = useState<TravailUpdateStatus | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let previous: TravailUpdateStatus | null = null;
    const refresh = async () => {
      let delay = 60_000;
      try {
        const response = await requestUpdate(baseUrl, token, lifetime.signal);
        if (!response.ok) return;
        const next = decodeStatus(await response.json());
        if (lifetime.signal.aborted) return;
        const installed = next?.installed;
        if (previous?.installed && installed && installed !== previous.installed) {
          toastManager.add({
            title: "Travail a été mis à jour",
            description: isElectron
              ? "Rouvre Travail pour utiliser la nouvelle version."
              : "Actualise la page pour utiliser la nouvelle version.",
          });
        }
        if (previous?.installing && next?.failed) {
          toastManager.add({ type: "error", title: "La mise à jour de Travail a échoué" });
        }
        previous = next;
        setStatus((current) =>
          current?.installed === next?.installed &&
          current?.available === next?.available &&
          current?.installing === next?.installing &&
          current?.failed === next?.failed
            ? current
            : next,
        );
        if (next?.installing) delay = 5_000;
        else if (next?.available) delay = 15_000;
      } catch {
        // A restart can temporarily interrupt polling. Keep the last state until reconnect.
        if (previous?.installing) delay = 5_000;
      } finally {
        if (!lifetime.signal.aborted) timer = setTimeout(() => void refresh(), delay);
      }
    };
    void refresh();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
    };
  }, [baseUrl, token]);

  if (!status?.available && !status?.installing) return null;
  const busy = starting || status.installing;
  const tooltip = busy ? "Installation en cours" : status.failed ? label + " · Réessayer" : label;

  async function install() {
    if (!status?.available || busy) return;
    setStarting(true);
    try {
      if (
        !(await requestConfirmDialog(
          "Installer la mise à jour de Travail ?\nLe serveur redémarrera après la validation.",
        ))
      )
        return;
      const response = await requestUpdate(baseUrl, token, undefined, {
        revision: status.available,
      });
      if (!response.ok) throw new Error("Update request failed");
      setStatus((current) => current && { ...current, installing: true, failed: false });
    } catch {
      toastManager.add({
        type: "error",
        title: "Impossible de lancer la mise à jour",
        description: "Attends la prochaine vérification, puis réessaie.",
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={className}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              disabled={busy}
              onClick={() => void install()}
              className="flex size-7 items-center justify-center rounded-full bg-info text-black hover:bg-info/85 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-75"
            >
              {busy ? <LoaderCircleIcon className="size-4" /> : <DownloadIcon className="size-4" />}
            </button>
          }
        />
        <TooltipPopup side="right">{tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function requestUpdate(
  baseUrl: string,
  token: string | null,
  signal?: AbortSignal,
  body?: TravailUpdateRequest,
) {
  return fetch(new URL("/api/harness/maintenance/travail-update", baseUrl), {
    method: body ? "POST" : "GET",
    credentials: token ? "omit" : "include",
    cache: "no-store",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(18_000)])
      : AbortSignal.timeout(18_000),
  });
}
