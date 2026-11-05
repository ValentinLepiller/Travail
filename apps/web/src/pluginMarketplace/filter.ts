import type { MarketplaceHarnessId, MarketplacePlugin } from "./catalog";

/**
 * Top-level sections of the Plugins page. Plugins lists every marketplace bundle; Apps, MCPs, and
 * Skills narrow the same catalog to bundles that ship that component (Skills also lists the
 * standalone skills installed on the environment).
 */
export const MARKETPLACE_SECTIONS = ["plugins", "apps", "mcps", "skills"] as const;
export type MarketplaceSection = (typeof MARKETPLACE_SECTIONS)[number];

export const MARKETPLACE_SECTION_LABELS: Readonly<Record<MarketplaceSection, string>> = {
  plugins: "Plugins",
  apps: "Apps",
  mcps: "MCPs",
  skills: "Skills",
};

export function isMarketplaceSection(value: unknown): value is MarketplaceSection {
  return MARKETPLACE_SECTIONS.some((section) => section === value);
}

export type MarketplaceStatusFilter = "all" | "installed" | "available";
export type MarketplaceHarnessFilter = "all" | MarketplaceHarnessId;
export type MarketplaceCategoryFilter = "all" | string;

export interface MarketplaceFilters {
  readonly query: string;
  readonly section: MarketplaceSection;
  readonly status: MarketplaceStatusFilter;
  readonly harness: MarketplaceHarnessFilter;
  readonly category: MarketplaceCategoryFilter;
}

function normalizeMarketplaceSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function pluginBelongsToSection(
  plugin: Pick<MarketplacePlugin, "contents">,
  section: MarketplaceSection,
): boolean {
  switch (section) {
    case "plugins":
      return true;
    case "apps":
      return plugin.contents.appCount > 0;
    case "mcps":
      return plugin.contents.mcpServerCount > 0;
    case "skills":
      return plugin.contents.skillCount > 0;
  }
}

function pluginSupportsHarness(
  plugin: Pick<MarketplacePlugin, "support">,
  harness: MarketplaceHarnessFilter,
): boolean {
  return harness === "all" || plugin.support.some((support) => support.harness === harness);
}

const SKILL_DRIVER_BY_HARNESS: Readonly<Record<MarketplaceHarnessId, string>> = {
  codex: "codex",
  claude: "claudeAgent",
  cursor: "cursor",
};

/** Matches a skill inventory entry, keyed by provider driver kind, against the harness filter. */
export function skillMatchesHarness(
  skillDriverKind: string,
  harness: MarketplaceHarnessFilter,
): boolean {
  return harness === "all" || SKILL_DRIVER_BY_HARNESS[harness] === skillDriverKind;
}

export function filterMarketplacePlugins(
  plugins: ReadonlyArray<MarketplacePlugin>,
  filters: MarketplaceFilters,
): MarketplacePlugin[] {
  const query = normalizeMarketplaceSearchText(filters.query);

  return plugins.filter((plugin) => {
    if (!pluginBelongsToSection(plugin, filters.section)) return false;
    if (filters.status === "installed" && !plugin.installed) return false;
    if (filters.status === "available" && plugin.installed) return false;
    if (!pluginSupportsHarness(plugin, filters.harness)) return false;
    if (filters.category !== "all" && plugin.category !== filters.category) return false;
    if (query.length === 0) return true;

    const searchText = normalizeMarketplaceSearchText(
      [
        plugin.name,
        plugin.packageName,
        plugin.summary,
        plugin.developer,
        plugin.category,
        plugin.marketplaceName,
        plugin.marketplaceLabel ?? "",
        ...plugin.support.map((support) => support.harness),
      ].join(" "),
    );

    return searchText.includes(query);
  });
}

export type MarketplaceSectionCounts = Readonly<Record<MarketplaceSection, number | null>>;

/**
 * What the section tabs count, like ChatGPT's manage bar: installed plugins, and the apps, MCP
 * servers, and skills those installed plugins ship. Skills adds the standalone skills installed on
 * the environment and stays null until that inventory has loaded.
 */
export function marketplaceSectionCounts(
  plugins: ReadonlyArray<MarketplacePlugin>,
  harness: MarketplaceHarnessFilter,
  standaloneSkillCount: number | null,
): MarketplaceSectionCounts {
  let installed = 0;
  let apps = 0;
  let mcps = 0;
  let skills = 0;
  for (const plugin of plugins) {
    if (!plugin.installed || !pluginSupportsHarness(plugin, harness)) continue;
    installed += 1;
    apps += plugin.contents.appCount;
    mcps += plugin.contents.mcpServerCount;
    skills += plugin.contents.skillCount;
  }
  return {
    plugins: installed,
    apps,
    mcps,
    skills: standaloneSkillCount === null ? null : standaloneSkillCount + skills,
  };
}
