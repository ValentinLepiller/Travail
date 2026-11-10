import { useProjects } from "../../state/entities";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, InboxSubject } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { workChantiers, notifyChantierSubject } from "../../state/workTasks";
import { Button } from "../ui/button";

export function InformChantier({
  environmentId,
  subject,
}: {
  environmentId: EnvironmentId;
  subject: InboxSubject;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const query = useEnvironmentQuery(workChantiers({ environmentId, input: {} }));
  const notify = useAtomCommand(notifyChantierSubject);
  const allowed = useAtomValue(notifyChantierSubject.permissionAtom(environmentId));
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const chantier = query.data?.find((c) => c.id === target);
  return (
    <div className="my-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Chantier à informer"
          className="max-w-full rounded border bg-background p-2 text-sm"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setStatus("");
          }}
        >
          <option value="">Choisir un chantier…</option>
          {query.data
            ?.filter((c) => c.status !== "done")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {projects.find((p) => p.id === c.projectId)?.title ?? "Projet indisponible"} ·{" "}
                {c.title} · {c.generation === "v2" ? "V2" : "Ancien"}
              </option>
            ))}
        </select>
        <Button
          variant="outline"
          disabled={busy || !allowed || !chantier}
          onClick={() => {
            if (!chantier) return;
            setBusy(true);
            setStatus("");
            void notify({
              environmentId,
              input: {
                id: chantier.id,
                generation: chantier.generation ?? "legacy",
                subjectId: subject.id,
                expectedEntries: subject.entries,
              },
            })
              .then((result) =>
                setStatus(
                  result._tag === "Failure"
                    ? String(squashAtomCommandFailure(result))
                    : "Les messages disponibles sont transmis une seule fois. Un nouvel appui transmettra les suivants.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Informer le chantier
        </Button>
      </div>
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
    </div>
  );
}
