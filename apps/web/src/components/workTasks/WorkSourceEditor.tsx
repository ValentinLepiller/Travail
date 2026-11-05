import type { WorkSource } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Button } from "../ui/button";

const SOURCE_LABELS: Record<WorkSource["kind"], string> = {
  manual: "Saisie manuelle",
  slack: "Slack",
  email: "Email",
  notion: "Notion",
  quote: "Devis",
  meeting: "Réunion",
  other: "Autre",
};
export function WorkSourceEditor({
  sources,
  onChange,
}: {
  sources: ReadonlyArray<WorkSource>;
  onChange: (sources: ReadonlyArray<WorkSource>) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Provenance</legend>
      {sources.map((source, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[130px_1fr_1fr_auto]">
          <select
            aria-label={`Source ${index + 1} : origine`}
            className="rounded-lg border bg-background px-2 text-sm"
            value={source.kind}
            onChange={(e) => {
              const kind = Object.keys(SOURCE_LABELS).find((k) => k === e.target.value) as
                | WorkSource["kind"]
                | undefined;
              if (kind) onChange(sources.map((s, i) => (i === index ? { ...s, kind } : s)));
            }}
          >
            {Object.entries(SOURCE_LABELS).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
          <Input
            aria-label={`Source ${index + 1} : libellé`}
            required
            maxLength={240}
            placeholder="Notes du point d’équipe"
            value={source.label}
            onChange={(e) =>
              onChange(sources.map((s, i) => (i === index ? { ...s, label: e.target.value } : s)))
            }
          />
          <Input
            aria-label={`Source ${index + 1} : lien`}
            type="url"
            pattern="https?://.*"
            maxLength={2000}
            placeholder="Lien (facultatif)"
            value={source.url ?? ""}
            onChange={(e) =>
              onChange(
                sources.map((s, i) => (i === index ? { ...s, url: e.target.value || null } : s)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(sources.filter((_, i) => i !== index))}
          >
            Retirer
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={sources.length >= 50}
        onClick={() => onChange([...sources, { kind: "manual", label: "", url: null }])}
      >
        Ajouter une source
      </Button>
    </fieldset>
  );
}
