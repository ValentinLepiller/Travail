import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const { layerRemoteHttpClient } = await import("@t3tools/client-runtime/rpc");
  return {
    connectionAtomRuntime: Atom.runtime(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    ),
  };
});
vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("~/state/session", () => ({ readPreparedConnection: vi.fn() }));

import { readPreparedConnection } from "~/state/session";
import { createPluginMarketplaceApi } from "./api";

const environmentId = EnvironmentId.make("selected-environment");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Selected environment",
  httpBaseUrl: "https://selected.example.test",
  wsBaseUrl: "wss://selected.example.test",
});
const prepared: PreparedConnection = {
  environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://selected.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "test-token" },
};
const fetchMock = vi.fn<typeof fetch>();

describe("plugin marketplace environment requests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      desktopBridge: { getLocalEnvironmentEnabled: () => false },
    });
    vi.mocked(readPreparedConnection).mockReturnValue(prepared);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the connected environment's catalog when the desktop local server is disabled", async () => {
    fetchMock.mockResolvedValue(Response.json({ plugins: [] }));

    const result = await createPluginMarketplaceApi(environmentId).fetchPluginMarketplaceCatalog();

    expect(result.plugins).toEqual([]);
    expect(readPreparedConnection).toHaveBeenCalledWith(environmentId);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://selected.example.test/api/plugins");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  });

  it("sends plugin searches and cookie credentials to the selected environment", async () => {
    vi.mocked(readPreparedConnection).mockReturnValue({ ...prepared, httpAuthorization: null });
    fetchMock.mockResolvedValue(Response.json({ plugins: [] }));

    await createPluginMarketplaceApi(environmentId).fetchPluginMarketplaceCatalog("notion");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://selected.example.test/api/plugins?q=notion");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("uses the current credential for installation and disconnection", async () => {
    const api = createPluginMarketplaceApi(environmentId);
    vi.mocked(readPreparedConnection).mockReturnValue({
      ...prepared,
      httpAuthorization: { _tag: "Bearer", token: "renewed-test-token" },
    });
    fetchMock
      .mockResolvedValueOnce(Response.json({ pluginId: "codex:notion@official", installed: true }))
      .mockResolvedValueOnce(
        Response.json({
          pluginId: "codex:notion@official",
          harness: "codex",
          serverId: "notion",
          status: "not_connected",
        }),
      );

    await api.installPlugin("codex:notion@official");
    await api.disconnectPluginMcpAuth("codex:notion@official", "codex", "notion");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://selected.example.test/api/plugins/codex%3Anotion%40official/install",
      "https://selected.example.test/api/plugins/codex%3Anotion%40official/mcp-auth/disconnect",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer renewed-test-token");
    }
  });

  it("refuses an unavailable environment without contacting a different server", async () => {
    vi.mocked(readPreparedConnection).mockReturnValue(null);

    await expect(
      createPluginMarketplaceApi(environmentId).fetchPluginMarketplaceCatalog(),
    ).rejects.toThrow("Connect to this environment to manage its plugins.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
