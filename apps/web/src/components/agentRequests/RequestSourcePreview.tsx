import type { AgentRequest } from "@t3tools/contracts";

export function RequestSourcePreview({ source }: { source: AgentRequest["source"] }) {
  if (!source) return null;
  return (
    <section aria-label="Message source" className="rounded-xl border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Message source · {source.label}</h3>
        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary hover:underline"
          >
            Ouvrir la source
          </a>
        )}
      </div>
      {source.author && (
        <p className="mt-2 break-words text-sm text-muted-foreground">{source.author}</p>
      )}
      {source.title && <p className="mt-2 break-words text-sm font-medium">{source.title}</p>}
      {source.text?.trim() ? (
        <blockquote className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm">
          {source.text}
        </blockquote>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Aperçu indisponible pour ce message.</p>
      )}
    </section>
  );
}
