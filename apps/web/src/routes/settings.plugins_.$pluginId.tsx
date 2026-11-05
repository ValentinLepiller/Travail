import { createFileRoute } from "@tanstack/react-router";

import { PluginDetail } from "../components/settings/pluginMarketplace/PluginDetail";
import { PluginMarketplaceProvider } from "../pluginMarketplace/PluginMarketplaceContext";

export const Route = createFileRoute("/settings/plugins_/$pluginId")({
  component: () => (
    <PluginMarketplaceProvider>
      <PluginDetail pluginId={Route.useParams().pluginId} />
    </PluginMarketplaceProvider>
  ),
});
