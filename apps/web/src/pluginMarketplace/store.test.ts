import type { PluginMarketplaceDetail, PluginMarketplacePlugin } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PluginMarketplaceApi } from "./api";
import { createPluginMarketplaceStore } from "./store";

const fetchPluginMarketplaceCatalog =
  vi.fn<PluginMarketplaceApi["fetchPluginMarketplaceCatalog"]>();
const fetchPluginMarketplaceDetail = vi.fn<PluginMarketplaceApi["fetchPluginMarketplaceDetail"]>();
const installPlugin = vi.fn<PluginMarketplaceApi["installPlugin"]>();
const removePlugin = vi.fn<PluginMarketplaceApi["removePlugin"]>();
const api = {
  fetchPluginMarketplaceCatalog,
  fetchPluginMarketplaceDetail,
  installPlugin,
  removePlugin,
};
let store = createPluginMarketplaceStore(api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const summary: PluginMarketplacePlugin = {
  id: "computer-use@openai-bundled",
  sourceHarness: "codex",
  packageName: "computer-use",
  name: "Computer Use",
  summary: "Control local Mac apps from Codex",
  developer: "OpenAI",
  category: "Productivity",
  version: "1.0.0",
  marketplaceName: "openai-bundled",
  marketplaceSourceType: "git",
  installPolicy: "AVAILABLE",
  authPolicy: "ON_INSTALL",
  installed: false,
  enabled: false,
  brandColor: null,
  hasLocalLogo: false,
  logoDataUrl: null,
  logoUrl: null,
  contents: {
    skillCount: 1,
    mcpServerCount: 1,
    appCount: 0,
    commandCount: 0,
    agentCount: 0,
    ruleCount: 0,
    hookCount: 0,
    hasHooks: false,
  },
  support: [{ harness: "codex", mcp: true, skills: true, apps: false }],
};

const detail: PluginMarketplaceDetail = {
  ...summary,
  installed: true,
  enabled: true,
  description: "Controls local apps through the real Codex plugin.",
  marketplaceUrl: null,
  homepage: null,
  repository: null,
  capabilities: [],
  defaultPrompts: [],
  skills: [
    {
      id: "computer-use",
      name: "Computer Use",
      description: "Operate local app UI.",
      invocation: "$computer-use:computer-use",
    },
  ],
  mcpServers: [
    {
      id: "computer-use",
      name: "Computer Use",
      transport: "stdio",
      url: null,
      oauthResource: null,
      note: null,
      toolTimeoutSeconds: null,
      environmentVariables: [],
    },
  ],
  apps: [],
  extensions: [],
  installTargets: [
    {
      pluginId: summary.id,
      harness: "codex",
      marketplaceName: "openai-bundled",
      version: "1.0.0",
      installed: true,
      enabled: true,
      installPolicy: "AVAILABLE",
      marketplaceUrl: null,
      contents: summary.contents,
    },
  ],
};

describe("plugin marketplace store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    store = createPluginMarketplaceStore(api);
  });

  it("loads the Codex catalog from the environment API", async () => {
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({ plugins: [summary] });

    await store.getState().loadCatalog();

    expect(fetchPluginMarketplaceCatalog).toHaveBeenCalledOnce();
    expect(store.getState().plugins).toEqual([summary]);
    expect(store.getState().catalogStatus).toBe("ready");
  });

  it("keeps a late catalog response on its original environment", async () => {
    const first = deferred<{ plugins: PluginMarketplacePlugin[] }>();
    fetchPluginMarketplaceCatalog.mockReturnValueOnce(first.promise);
    const loading = store.getState().loadCatalog();
    const otherPlugin = { ...summary, name: "Other environment", installed: true };
    const other = createPluginMarketplaceStore({
      ...api,
      fetchPluginMarketplaceCatalog: vi.fn().mockResolvedValue({ plugins: [otherPlugin] }),
    });

    await other.getState().loadCatalog();
    first.resolve({ plugins: [summary] });
    await loading;

    expect(store.getState().plugins).toEqual([summary]);
    expect(other.getState().plugins).toEqual([otherPlugin]);
  });

  it("keeps installation progress and detail caches separate between environments", async () => {
    const installed = deferred<{ pluginId: string; installed: boolean }>();
    installPlugin.mockReturnValueOnce(installed.promise);
    fetchPluginMarketplaceCatalog.mockResolvedValue({ plugins: [summary] });
    fetchPluginMarketplaceDetail.mockResolvedValue(detail);
    const other = createPluginMarketplaceStore(api);
    const mutation = store.getState().setInstalled(summary.id, true);

    expect(store.getState().pending[summary.id]).toBe(true);
    expect(other.getState().pending[summary.id]).toBeUndefined();
    installed.resolve({ pluginId: summary.id, installed: true });
    await mutation;

    expect(store.getState().details[summary.id]?.plugin).toEqual(detail);
    expect(other.getState().details).toEqual({});
  });

  it("keeps per-harness notices from the catalog and clears them when a server omits them", async () => {
    const notice = {
      harness: "codex",
      status: "syncing",
      message: "Codex is still syncing its plugin marketplaces.",
    } as const;
    vi.mocked(fetchPluginMarketplaceCatalog)
      .mockResolvedValueOnce({ plugins: [summary], notices: [notice] })
      .mockResolvedValueOnce({ plugins: [summary] });

    await store.getState().loadCatalog();
    expect(store.getState().notices).toEqual([notice]);

    await store.getState().loadCatalog(true);
    expect(store.getState().notices).toEqual([]);
  });

  it("queues forced catalog refreshes behind an in-flight request", async () => {
    let resolveFirst: ((value: { plugins: PluginMarketplacePlugin[] }) => void) | undefined;
    vi.mocked(fetchPluginMarketplaceCatalog)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ plugins: [{ ...summary, installed: true, enabled: true }] });

    const first = store.getState().loadCatalog(true);
    const forced = store.getState().loadCatalog(true);
    resolveFirst?.({ plugins: [summary] });
    await Promise.all([first, forced]);

    expect(fetchPluginMarketplaceCatalog).toHaveBeenCalledTimes(2);
    expect(store.getState().plugins[0]?.installed).toBe(true);
  });

  it("runs a real install mutation and refreshes catalog and details", async () => {
    vi.mocked(installPlugin).mockResolvedValue({ pluginId: summary.id, installed: true });
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({
      plugins: [{ ...summary, installed: true, enabled: true }],
    });
    vi.mocked(fetchPluginMarketplaceDetail).mockResolvedValue(detail);

    await store.getState().setInstalled(summary.id, true);

    expect(installPlugin).toHaveBeenCalledWith(summary.id);
    expect(store.getState().plugins[0]?.installed).toBe(true);
    expect(store.getState().details[summary.id]?.plugin).toEqual(detail);
    expect(store.getState().pending[summary.id]).toBe(false);
  });

  it("runs remove through Codex", async () => {
    vi.mocked(removePlugin).mockResolvedValue({ pluginId: summary.id, installed: false });
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({ plugins: [summary] });
    vi.mocked(fetchPluginMarketplaceDetail).mockResolvedValue({
      ...detail,
      installed: false,
      enabled: false,
    });

    await store.getState().setInstalled(summary.id, false);

    expect(removePlugin).toHaveBeenCalledWith(summary.id);
    expect(store.getState().details[summary.id]?.plugin?.installed).toBe(false);
  });

  it("keeps ChatGPT public search hits that the browse catalog omitted", async () => {
    const tickTick = {
      ...summary,
      id: "codex:app-ticktick@chatgpt-public",
      packageName: "app-ticktick",
      name: "TickTick:To-Do List & Calendar",
      marketplaceName: "ChatGPT Public",
    };
    vi.mocked(fetchPluginMarketplaceCatalog)
      .mockResolvedValueOnce({ plugins: [summary] })
      .mockResolvedValueOnce({ plugins: [summary, tickTick] });

    await store.getState().loadCatalog();
    await store.getState().searchCatalog("tick");

    expect(fetchPluginMarketplaceCatalog).toHaveBeenNthCalledWith(2, "tick");
    expect(store.getState().searchHits).toEqual([tickTick]);

    await store.getState().searchCatalog("t");
    expect(store.getState().searchHits).toEqual([]);
  });
});
