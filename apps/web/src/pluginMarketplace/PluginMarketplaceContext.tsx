import * as Option from "effect/Option";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";

import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "~/components/settings/settingsLayout";
import { usePreparedConnection } from "~/state/session";
import { createPluginMarketplaceApi, type PluginMarketplaceApi } from "./api";
import { createPluginMarketplaceStore, type PluginMarketplaceStoreState } from "./store";

const PluginMarketplaceContext = createContext<{
  api: PluginMarketplaceApi;
  store: ReturnType<typeof createPluginMarketplaceStore>;
} | null>(null);

export function PluginMarketplaceProvider({ children }: { children: ReactNode }) {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const prepared = usePreparedConnection(environmentId);
  const value = useMemo(() => {
    if (environmentId === null) return null;
    const api = createPluginMarketplaceApi(environmentId);
    return { api, store: createPluginMarketplaceStore(api) };
  }, [environmentId]);

  if (value === null || Option.isNone(prepared)) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect to an environment to manage its plugins.
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <PluginMarketplaceContext.Provider key={environmentId} value={value}>
      {children}
    </PluginMarketplaceContext.Provider>
  );
}

export function usePluginMarketplaceApi() {
  return usePluginMarketplaceContext().api;
}

function usePluginMarketplaceContext() {
  const value = useContext(PluginMarketplaceContext);
  if (value === null) throw new Error("Plugin marketplace requires an environment.");
  return value;
}

export function usePluginMarketplaceStore<T>(selector: (state: PluginMarketplaceStoreState) => T) {
  return useStore(usePluginMarketplaceContext().store, selector);
}
