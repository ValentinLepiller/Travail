import { EyeIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

interface VisibilityProps {
  projects: readonly SidebarProjectSnapshot[];
  hiddenKeys: ReadonlySet<string>;
  onVisibilityChange: (projectKeys: readonly string[], visible: boolean) => void;
}

export function SidebarProjectVisibility({
  projects,
  hiddenKeys,
  onVisibilityChange,
}: VisibilityProps) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const matches = projects.filter((project) =>
    project.displayName.toLocaleLowerCase().includes(search),
  );
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <PopoverTrigger render={<SidebarHeaderIconButton label="Visible projects" />}>
        <EyeIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="start" width="sm" padding="compact">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Visible projects</span>
            <Button
              variant="ghost-muted"
              size="xs"
              onClick={() => onVisibilityChange([...hiddenKeys], true)}
            >
              Show all
            </Button>
          </div>
          <Input
            type="search"
            aria-label="Search visible projects"
            placeholder="Search projects..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-80 overflow-y-auto">
            {matches.map((project) => {
              const keys = project.memberProjectRefs.map(scopedProjectKey);
              const checked = keys.every((key) => !hiddenKeys.has(key));
              const partial = !checked && keys.some((key) => !hiddenKeys.has(key));
              return (
                <label
                  key={project.projectKey}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-2 hover:bg-accent"
                >
                  <Checkbox
                    aria-label={project.displayName}
                    checked={checked}
                    indeterminate={partial}
                    onCheckedChange={(visible) => onVisibilityChange(keys, visible)}
                  />
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">{project.displayName}</span>
                </label>
              );
            })}
            {matches.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">No matching projects.</p>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SidebarProjectHeader({
  project,
  onNewThread,
  onSettings,
}: {
  project: SidebarProjectSnapshot;
  onNewThread: (project: SidebarProjectSnapshot) => void;
  onSettings: (project: SidebarProjectSnapshot) => void;
}) {
  return (
    <div className="group flex items-center gap-1 rounded-md hover:bg-sidebar-row-hover">
      <button
        type="button"
        aria-label={`New thread in ${project.displayName}`}
        onClick={() => onNewThread(project)}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      >
        <ProjectFavicon project={project} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
        <PlusIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
      </button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Project settings for ${project.displayName}`}
        onClick={() => onSettings(project)}
      >
        <SettingsIcon className="size-3.5" />
      </Button>
    </div>
  );
}
