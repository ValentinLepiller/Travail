import { createFileRoute } from "@tanstack/react-router";

import { PluginMarketplace } from "../components/settings/pluginMarketplace/PluginMarketplace";
import { PluginMarketplaceProvider } from "../pluginMarketplace/PluginMarketplaceContext";
import { MARKETPLACE_HARNESSES } from "../pluginMarketplace/catalog";
import { isMarketplaceSection, type MarketplaceSection } from "../pluginMarketplace/filter";

function PluginsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The section and harness live in the URL so returning from a plugin's detail page lands on the
  // same tab, and other surfaces can link straight to Apps, MCPs, or Skills.
  return (
    <PluginMarketplaceProvider>
      <PluginMarketplace
        section={search.section ?? "plugins"}
        harness={search.harness ?? "all"}
        onSectionChange={(section) =>
          void navigate({
            search: ({ section: _previous, ...rest }) =>
              section === "plugins" ? rest : { ...rest, section },
            replace: true,
          })
        }
        onHarnessChange={(harness) =>
          void navigate({
            search: ({ harness: _previous, ...rest }) =>
              harness === "all" ? rest : { ...rest, harness },
            replace: true,
          })
        }
      />
    </PluginMarketplaceProvider>
  );
}

export const Route = createFileRoute("/settings/plugins")({
  validateSearch: (raw: Record<string, unknown>) => {
    const harness = MARKETPLACE_HARNESSES.find((candidate) => candidate === raw.harness);
    const section: MarketplaceSection | undefined =
      isMarketplaceSection(raw.section) && raw.section !== "plugins" ? raw.section : undefined;
    return {
      ...(section ? { section } : {}),
      ...(harness ? { harness } : {}),
    };
  },
  component: PluginsRoute,
});
