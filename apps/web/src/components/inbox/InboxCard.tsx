import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";

export function InboxCard({
  open,
  onOpenChange,
  icon,
  heading,
  aside,
  children,
  embedded = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: ReactNode;
  heading: ReactNode;
  aside: ReactNode;
  children: ReactNode;
  embedded?: boolean;
}) {
  return (
    <div className={embedded ? "border-b border-border/60 last:border-b-0" : "pb-2"}>
      <details
        open={open}
        onToggle={(event) => onOpenChange(event.currentTarget.open)}
        className={
          embedded
            ? "group"
            : "group overflow-hidden rounded-2xl border border-border bg-card hover:border-foreground/20 open:border-primary/40 open:bg-accent/40"
        }
      >
        <summary
          className={`flex cursor-pointer list-none items-center gap-3 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden ${embedded ? "py-3" : "min-h-19 px-3.5 py-3"}`}
        >
          <span
            className={
              embedded
                ? "flex size-7 shrink-0 items-center justify-center text-muted-foreground"
                : "flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
            }
          >
            {icon}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">{heading}</span>
          <span className="flex shrink-0 flex-col items-end gap-1.5">{aside}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={`hidden size-3.5 shrink-0 text-muted-foreground sm:block ${open ? "rotate-180" : ""}`}
          />
        </summary>
        {open ? (
          <div className={embedded ? "pb-3" : "mx-3.5 border-t border-border/60 py-3"}>
            {children}
          </div>
        ) : null}
      </details>
    </div>
  );
}
