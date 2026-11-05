import type { SkillInventory, SkillInventoryInstallation } from "@t3tools/contracts";
import {
  fetchEnvironmentSkillInventory,
  filterSkillInventory,
  formatSkillPath,
  skillKey,
} from "@t3tools/client-runtime/state/skills";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowRightIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "~/components/chat/providerIconUtils";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { runtime } from "~/lib/runtime";
import { skillMatchesHarness, type MarketplaceHarnessFilter } from "~/pluginMarketplace/filter";
import { useSettingsScope } from "../SettingsScopeContext";
import { usePreparedConnection } from "~/state/session";
import { SkillFileDetail } from "../SkillsSettings";

const SKILL_PAGE_SIZE = 12;

export type SkillInventoryState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "loaded"; readonly inventory: SkillInventory }
  | { readonly status: "error"; readonly message: string };

/** Standalone skills installed on the environment whose plugin catalog the page shows. */
export function useMarketplaceSkillInventory(refreshKey: number): SkillInventoryState {
  const { environment } = useSettingsScope();
  const prepared = usePreparedConnection(environment?.environmentId ?? null);
  const [state, setState] = useState<SkillInventoryState>({ status: "loading" });

  useEffect(() => {
    if (Option.isNone(prepared)) return;
    let cancelled = false;
    setState((current) => (current.status === "loaded" ? current : { status: "loading" }));
    void runtime
      .runPromise(fetchEnvironmentSkillInventory({ prepared: prepared.value }))
      .then((inventory) => {
        if (!cancelled) setState({ status: "loaded", inventory });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : "Could not load skills.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [prepared, refreshKey]);

  return Option.isNone(prepared) ? { status: "unavailable" } : state;
}

export function visibleSkills(
  state: SkillInventoryState,
  query: string,
  harness: MarketplaceHarnessFilter,
): ReadonlyArray<SkillInventoryInstallation> | null {
  if (state.status !== "loaded") return null;
  return filterSkillInventory(state.inventory, query)
    .installations.filter((skill) => skillMatchesHarness(skill.harness, harness))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function SkillCard({
  skill,
  onOpen,
}: {
  readonly skill: SkillInventoryInstallation;
  readonly onOpen: () => void;
}) {
  const HarnessIcon = PROVIDER_ICON_BY_PROVIDER[skill.harness] ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View ${skill.name} skill`}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-foreground/8 bg-card/24 p-3 text-left outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-card/40"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-foreground/8 bg-foreground/5 text-muted-foreground"
      >
        <SparklesIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm text-foreground">{skill.name}</span>
        <span className="block truncate text-muted-foreground text-xs/5 sm:text-sm/5">
          {skill.description ?? "No description"}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {HarnessIcon ? <HarnessIcon aria-hidden className="size-3 shrink-0" /> : null}
          <span className="shrink-0">{skill.harnessDisplayName}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate font-mono text-2xs">
            {formatSkillPath(skill.directoryPath)}
          </span>
        </span>
      </span>
    </button>
  );
}

/** The environment's standalone skills as cards; each opens its SKILL.md in a dialog. */
export function InstalledSkillsSection({
  state,
  skills,
  onRetry,
}: {
  readonly state: SkillInventoryState;
  readonly skills: ReadonlyArray<SkillInventoryInstallation> | null;
  readonly onRetry: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(SKILL_PAGE_SIZE);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openSkill = useMemo(
    () => skills?.find((skill) => skillKey(skill) === openKey) ?? null,
    [openKey, skills],
  );
  const visible = skills?.slice(0, visibleCount) ?? [];

  return (
    <section className="space-y-2" aria-labelledby="marketplace-section-installed-skills">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="marketplace-section-installed-skills"
          className="font-semibold text-lg text-foreground"
        >
          Your skills
        </h2>
        {skills ? (
          <p className="tabular-nums text-base text-muted-foreground sm:text-sm">
            {skills.length} {skills.length === 1 ? "skill" : "skills"}
          </p>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Scanning skills…
        </p>
      ) : state.status === "unavailable" ? (
        <p className="text-muted-foreground text-sm">
          Connect to this environment to see its skills.
        </p>
      ) : state.status === "error" ? (
        <div className="flex items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            {state.message}
          </p>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No standalone skills match. Skills bundled in plugins are listed below.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.map((skill) => (
            <SkillCard
              key={skillKey(skill)}
              skill={skill}
              onOpen={() => setOpenKey(skillKey(skill))}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {skills && visible.length < skills.length ? (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => setVisibleCount((count) => count + SKILL_PAGE_SIZE * 2)}
          >
            Show {Math.min(SKILL_PAGE_SIZE * 2, skills.length - visible.length)} more
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" variant="ghost-muted" render={<Link to="/settings/skills" />}>
          Skills on every computer
          <ArrowRightIcon />
        </Button>
      </div>
      <Dialog open={openSkill !== null} onOpenChange={(open) => !open && setOpenKey(null)}>
        {openSkill ? (
          <DialogPopup className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{openSkill.name}</DialogTitle>
              <DialogDescription>
                {openSkill.description ?? "No description in this skill's frontmatter."}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SkillFileDetail skill={openSkill} />
            </DialogPanel>
          </DialogPopup>
        ) : null}
      </Dialog>
    </section>
  );
}
