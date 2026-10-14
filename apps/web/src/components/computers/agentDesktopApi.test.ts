import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeAgentDesktopClient } from "./agentDesktopApi";

const environmentId = EnvironmentId.make("worker-environment");
const threadId = ThreadId.make("mcp:39ad607e-test");
const leaseId = "00000000-0000-4000-8000-000000000001";
const remote: DeviceHubAccess = {
  httpBase: "https://worker.example/api/agent-desktops",
  wsBase: "wss://worker.example/api/agent-desktops",
  query: {},
  credentials: true,
};
const target = { sessionId: "desktop-instance", revision: 2 };
const status = {
  ...target,
  ownerId: `${threadId}/${leaseId}`,
  display: ":88",
  width: 1280,
  height: 800,
  controller: "human",
  applications: 1,
};

it("discovers leases on the selected HTTPS environment using its cookie", async () => {
  const readAccess = vi.fn(async () => remote);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{ leaseId, status }]));
  const client = makeAgentDesktopClient(environmentId, threadId, { readAccess, fetch });
  expect((await client.list())[0]?.leaseId).toBe(leaseId);
  expect(readAccess).toHaveBeenCalledWith(environmentId, false);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://worker.example/api/agent-desktops/mcp%3A39ad607e-test",
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", cache: "no-store" });
});

describe("desktop destination ticket renewal", () => {
  it("renews an expired destination ticket and decodes the screenshot", async () => {
    const readAccess = vi.fn(async (_environmentId: EnvironmentId, fresh?: boolean) => ({
      ...remote,
      credentials: false,
      query: { wsTicket: fresh ? "renewed-fixture" : "expired-fixture" },
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>(async () =>
        Response.json({
          status,
          windows: [{ id: "42", title: "Private app" }],
          screenshot: { mimeType: "image/png", data: "png", width: 1280, height: 800 },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const client = makeAgentDesktopClient(environmentId, threadId, { readAccess, fetch });
    expect((await client.capture(leaseId)).status.controller).toBe("human");
    expect(readAccess).toHaveBeenLastCalledWith(environmentId, true);
    expect(fetch.mock.calls[1]?.[0]).toContain("capture=1&wsTicket=renewed-fixture");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ credentials: "omit" });
  });

  it.each([403, 409, 423])(
    "does not retry a refused mutation (%s) or expose its body",
    async (code) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response("private server diagnostics", { status: code }),
      );
      const readAccess = vi.fn(async () => remote);
      const client = makeAgentDesktopClient(environmentId, threadId, { readAccess, fetch });
      await expect(client.act(leaseId, { action: "take", target })).rejects.not.toThrow(
        "private server diagnostics",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("stops after one fresh ticket is also refused", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }));
    const client = makeAgentDesktopClient(environmentId, threadId, {
      readAccess: async () => remote,
      fetch,
    });
    await expect(client.list()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid screenshot response instead of presenting success", async () => {
    const client = makeAgentDesktopClient(environmentId, threadId, {
      readAccess: async () => remote,
      fetch: async () => Response.json({ screenshot: "missing typed frame" }),
    });
    await expect(client.capture(leaseId)).rejects.toThrow();
  });
});

it("calls a native-style fetch callback without an arbitrary object receiver", async () => {
  const nativeLikeFetch: typeof globalThis.fetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(Response.json([]));
  };
  const client = makeAgentDesktopClient(environmentId, threadId, {
    readAccess: async () => remote,
    fetch: nativeLikeFetch,
  });
  await expect(client.list()).resolves.toEqual([]);
});
