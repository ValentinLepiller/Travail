import type { ProjectIconColor } from "@t3tools/contracts";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { cn } from "~/lib/utils";

export function ProjectColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ProjectIconColor;
  onChange: (color: ProjectIconColor) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Project color">
      {PROJECT_ICON_COLORS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-label={option.label}
          aria-pressed={value === option.value}
          disabled={disabled}
          className={cn(
            "flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
            value === option.value && "border-foreground/64",
          )}
          onClick={() => onChange(option.value)}
        >
          <span className={cn("size-4 rounded-full", option.swatchClassName)} />
        </button>
      ))}
    </div>
  );
}
