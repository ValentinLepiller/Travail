// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Real isolated loopback listeners and protocol boundaries.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { assertMtAuth, openGateway, webSocketStatus } from "./gateway.ts";
import { decodeRemoteConfig, cloudflaredArguments } from "./config.ts";
import { remoteUnit, startRemote } from "./tunnel.ts";
import { healthRemote, sessionState } from "./health.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function requestHttp(url: string, options: { headers?: NodeHttp.OutgoingHttpHeaders } = {}) {
  return new Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>((resolve, reject) => {
    const request = NodeHttp.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = response.headers[name];
              return value === undefined
                ? null
                : Array.isArray(value)
                  ? value.join(", ")
                  : String(value);
            },
          },
          json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

async function fixture(protocolVersion = 2) {
  const sockets = new Set<import("node:net").Socket>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/api/auth/session") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          authenticated:
            request.headers.authorization === "Bearer fixture" &&
            request.headers["x-t3-orchestration-protocol"] === String(protocolVersion),
        }),
      );
      return;
    }
    if (request.url === "/.well-known/t3/environment") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ environmentId: "fixture", orchestrationProtocolVersion: protocolVersion }),
      );
      return;
    }
    if (
      request.url === "/api/orchestration/shell" &&
      request.headers.cookie !== "session=fixture"
    ) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("set-cookie", "session=fixture; HttpOnly; SameSite=Lax; Path=/");
    response.end(
      JSON.stringify({
        host: request.headers.host,
        forwarded: request.headers["x-forwarded-host"],
        protocol: request.headers["x-forwarded-proto"],
        spoofed: request.headers.forwarded,
        cookie: request.headers.cookie,
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    if (
      new URL(request.url!, "http://fixture").searchParams.get("orchestrationProtocol") !==
      String(protocolVersion)
    ) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (request.headers.cookie !== "session=fixture") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = NodeCrypto.createHash("sha1")
      .update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

it("refuses another MT identity and verifies anonymous HTTP/WebSocket rejection", async () => {
  const origin = await fixture();
  await expect(assertMtAuth(origin, "fixture")).resolves.toBe(2);
  await expect(assertMtAuth(origin, "wrong-environment")).rejects.toThrow("Unexpected MT");
});

it("checks authentication using the server protocol after an independent runtime promotion", async () => {
  await expect(assertMtAuth(await fixture(3), "fixture")).resolves.toBe(3);
  await expect(assertMtAuth(await fixture(-1), "fixture")).rejects.toThrow("Unexpected MT");
});

it("keeps MT authentication authoritative and secures cookies behind the HTTPS origin", async () => {
  const origin = await fixture();
  const gateway = await openGateway(origin, 0, "https://fixture.example");
  cleanups.push(gateway.close);
  const url = `http://127.0.0.1:${gateway.port}`;
  expect(
    (await requestHttp(`${url}/api/orchestration/shell`, { headers: { host: "fixture.example" } }))
      .status,
  ).toBe(401);
  expect(await webSocketStatus(url, { host: "fixture.example" })).toBe(401);
  expect(
    await webSocketStatus(url, {
      host: "fixture.example",
      origin: "https://fixture.example",
      cookie: "session=fixture",
    }),
  ).toBe(101);
  const response = await requestHttp(`${url}/api/orchestration/shell`, {
    headers: {
      host: "fixture.example",
      origin: "https://fixture.example",
      cookie: "session=fixture",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
      forwarded: "host=attacker.example",
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    host: "fixture.example",
    forwarded: "fixture.example",
    protocol: "https",
    cookie: "session=fixture",
  });
  expect(response.headers.get("set-cookie")).toContain("; Secure");
  expect(response.headers.get("permissions-policy")).toBe("microphone=(self)");
});

it("rejects mismatched hosts/origins even when an attacker spoofs browser/proxy headers", async () => {
  const gateway = await openGateway(await fixture(), 0, "https://fixture.example");
  cleanups.push(gateway.close);
  const url = `http://127.0.0.1:${gateway.port}`;
  expect((await requestHttp(url)).status).toBe(403);
  expect(
    (
      await requestHttp(url, {
        headers: {
          host: "fixture.example",
          origin: "https://attacker.example",
          "sec-fetch-site": "same-origin",
          "x-forwarded-host": "attacker.example",
          cookie: "session=fixture",
        },
      })
    ).status,
  ).toBe(403);
  expect(
    await webSocketStatus(url, {
      host: "fixture.example",
      origin: "https://attacker.example",
      cookie: "session=fixture",
    }),
  ).toBe(403);
});

it("keeps a newly-created tunnel closed until its HTTPS hostname is known", async () => {
  const gateway = await openGateway(await fixture(), 0);
  cleanups.push(gateway.close);
  const url = `http://127.0.0.1:${gateway.port}`;
  expect((await requestHttp(url, { headers: { host: "fixture.example" } })).status).toBe(503);
  gateway.setPublicOrigin("https://fixture.example");
  expect((await requestHttp(url, { headers: { host: "fixture.example" } })).status).toBe(200);
});

it("rejects absolute and malformed request targets without crashing the proxy", async () => {
  const gateway = await openGateway(await fixture(), 0, "https://fixture.example");
  cleanups.push(gateway.close);
  for (const path of ["http://127.0.0.1:1/private", "//attacker.example/private", "/\\[bad"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = NodeHttp.request(
        {
          hostname: "127.0.0.1",
          port: gateway.port,
          path,
          headers: { host: "fixture.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  }
  expect(
    (
      await requestHttp(`http://127.0.0.1:${gateway.port}`, {
        headers: { host: "fixture.example" },
      })
    ).status,
  ).toBe(200);
});

it("requires explicit shared-host coordination and keeps stable/temporary tunnel contracts separate", async () => {
  const base = {
    origin: "http://127.0.0.1:3773",
    environmentId: "fixture",
    proxyPort: 3874,
    mode: "quick",
    directory: "/fixture/remote",
    sharedOriginApproved: false,
  };
  await expect(startRemote(decodeRemoteConfig(base))).rejects.toThrow("parent coordination");
  const quick = decodeRemoteConfig({ ...base, sharedOriginApproved: true });
  expect(cloudflaredArguments(quick, "/fixture/config")).toContain("--url");
  expect(() => decodeRemoteConfig({ ...base, origin: "http://0.0.0.0:3873" })).toThrow("loopback");
  expect(() => decodeRemoteConfig({ ...quick, mode: "named" })).toThrow("approved hostname");
  const named = decodeRemoteConfig({
    ...quick,
    mode: "named",
    hostname: "fixture.example",
    tunnelId: "00000000-0000-0000-0000-000000000000",
    credentialsFile: "/fixture/credentials.json",
  });
  expect(cloudflaredArguments(named, "/fixture/config")).toContain("run");
  expect(cloudflaredArguments(named, "/fixture/config")).not.toContain("--token");
  expect(
    remoteUnit("/fixture/node", "/fixture/harness-remote.ts", "/fixture/config.json"),
  ).toContain("BindsTo=mt-harness.service");
});

it("never exposes malformed named-tunnel credential content in startup errors", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "remote-credentials-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const credentialsFile = NodePath.join(directory, "credentials.json");
  const marker = "FAKESECRET";
  await NodeFSP.writeFile(credentialsFile, `{"TunnelSecret": ${marker}}`, { mode: 0o600 });
  const failure = await startRemote({
    origin: "http://127.0.0.1:3873",
    environmentId: "fixture",
    proxyPort: 3874,
    mode: "named",
    hostname: "fixture.example",
    tunnelId: "00000000-0000-0000-0000-000000000000",
    credentialsFile,
    directory,
    sharedOriginApproved: false,
  }).catch((error: unknown) => error);
  if (!(failure instanceof Error)) throw new Error("Expected named-tunnel startup to fail");
  expect(failure.message).toBe("Cannot read valid private Cloudflare tunnel credentials");
  expect(String(failure)).not.toContain(marker);
});

it("reports deliberately unapproved remote publication as inapplicable without contacting MT", async () => {
  await expect(
    healthRemote({
      origin: "http://127.0.0.1:3773",
      environmentId: "fixture",
      proxyPort: 3874,
      mode: "quick",
      directory: "/nonexistent-remote-fixture",
      sharedOriginApproved: false,
    }),
  ).resolves.toEqual({ required: false, reason: "publication-not-approved" });
});

it("uses authenticated state rather than HTTP 200 to detect a revoked session", async () => {
  const origin = await fixture();
  await expect(sessionState(origin, "fixture", 2)).resolves.toEqual({
    status: 200,
    authenticated: true,
  });
  await expect(sessionState(origin, "revoked-fixture", 2)).resolves.toEqual({
    status: 200,
    authenticated: false,
  });
});
