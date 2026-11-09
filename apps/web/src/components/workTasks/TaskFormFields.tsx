import type { ComponentProps, ReactNode } from "react";

export function TaskSelect(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
    />
  );
}

export function TaskField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
