import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";

export function CollectionAutomationDetail({
  name,
  sources,
  onClose,
  children,
}: {
  name: string;
  children?: ReactNode;
  sources: Record<"script" | "service", { path: string; code: string }>;
  onClose: () => void;
}) {
  const [source, setSource] = useState<keyof typeof sources>("script");
  const file = sources[source];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">Messages {name}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Fermer
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Le service collecte les messages chaque minute lorsque la collecte est activée. Le script
        interroge {name} ; les messages admissibles deviennent des tâches à qualifier.
      </p>
      <p className="text-xs text-muted-foreground">
        Code de cette version de l’application, en lecture seule. L’état de la collecte sur la
        machine sélectionnée n’est pas affiché ici.
      </p>
      {children}
      <div className="flex gap-2" role="group" aria-label="Fichier à consulter">
        <Button
          variant={source === "script" ? "default" : "outline"}
          size="sm"
          aria-pressed={source === "script"}
          onClick={() => setSource("script")}
        >
          Script {name}
        </Button>
        <Button
          variant={source === "service" ? "default" : "outline"}
          size="sm"
          aria-pressed={source === "service"}
          onClick={() => setSource("service")}
        >
          Service de collecte
        </Button>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">{file.path}</p>
      <pre
        className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs"
        tabIndex={0}
        aria-label={file.path}
      >
        <code>{file.code}</code>
      </pre>
    </div>
  );
}
