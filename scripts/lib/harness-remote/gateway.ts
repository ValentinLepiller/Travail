// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - Streaming reverse-proxy boundary.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import { httpsOrigin } from "./config.ts";

const protectedPath = "/api/orchestration/shell";
export function webSocketStatus(
  origin: string,
  headers: NodeHttp.OutgoingHttpHeaders = {},
  options: { protocolVersion?: number; ticket?: string } = {},
) {
  return new Promise<number>((resolve, reject) => {
    const url = new URL("/ws", origin);
    url.searchParams.set("orchestrationProtocol", String(options.protocolVersion ?? 2));
    if (options.ticket) url.searchParams.set("wsTicket", options.ticket);
    const transport = url.protocol === "https:" ? NodeHttps : NodeHttp;
    const request = transport.request(url, {
      ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
      },
    });
    const timeout = setTimeout(
      () => request.destroy(new Error("WebSocket check timed out")),
      5_000,
    );
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.on("response", (response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("upgrade", (_response, socket) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(101);
    });
    request.end();
  });
}

export async function assertMtAuth(origin: string, environmentId: string) {
  const descriptor = await fetch(new URL("/.well-known/t3/environment", origin), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!descriptor.ok) throw new Error("MT descriptor is unavailable");
  const value = (await descriptor.json()) as {
    environmentId?: unknown;
    orchestrationProtocolVersion?: unknown;
  };
  if (
    value.environmentId !== environmentId ||
    typeof value.orchestrationProtocolVersion !== "number" ||
    !Number.isSafeInteger(value.orchestrationProtocolVersion) ||
    value.orchestrationProtocolVersion < 1
  )
    throw new Error("Unexpected MT environment");
  const response = await fetch(new URL(protectedPath, origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (
    response.status !== 401 ||
    (await webSocketStatus(origin, {}, { protocolVersion: value.orchestrationProtocolVersion })) !==
      401
  )
    throw new Error(
      "Refusing publication: HTTP and WebSocket must reject anonymous clients with 401",
    );
  return value.orchestrationProtocolVersion;
}

export function secureCookies(value: string | string[] | undefined) {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map((cookie) =>
    /;\s*secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`,
  );
}

export async function openGateway(origin: string, port: number, initialPublicOrigin?: string) {
  let publicOrigin = initialPublicOrigin ? httpsOrigin(initialPublicOrigin) : undefined;
  const sockets = new Set<NodeStream.Duplex>();
  function headers(request: NodeHttp.IncomingMessage): NodeHttp.OutgoingHttpHeaders | undefined {
    try {
      if (
        !request.url?.startsWith("/") ||
        request.url.startsWith("//") ||
        new URL(request.url, origin).origin !== new URL(origin).origin
      )
        return undefined;
    } catch {
      return undefined;
    }
    if (!publicOrigin || request.headers.host?.toLowerCase() !== new URL(publicOrigin).host)
      return undefined;
    if (request.headers.origin && request.headers.origin !== publicOrigin) return undefined;
    const outgoing = { ...request.headers };
    for (const key of Object.keys(outgoing)) {
      if (
        key === "forwarded" ||
        key.startsWith("x-forwarded-") ||
        key === "cf-connecting-ip" ||
        key === "sec-fetch-site" ||
        key === "proxy-authorization" ||
        key === "proxy-connection"
      )
        delete outgoing[key];
    }
    outgoing.host = new URL(publicOrigin).host;
    outgoing["x-forwarded-host"] = outgoing.host;
    outgoing["x-forwarded-proto"] = "https";
    return outgoing;
  }
  const server = NodeHttp.createServer((request, response) => {
    const outgoing = headers(request);
    if (!outgoing) {
      response.writeHead(publicOrigin ? 403 : 503).end();
      return;
    }
    const upstream = NodeHttp.request(
      new URL(request.url ?? "/", origin),
      { method: request.method, headers: outgoing },
      (reply) => {
        const result = { ...reply.headers };
        const cookies = secureCookies(result["set-cookie"]);
        if (cookies) result["set-cookie"] = cookies;
        result["strict-transport-security"] = "max-age=31536000";
        result["referrer-policy"] = "no-referrer";
        result["permissions-policy"] = "microphone=(self)";
        response.writeHead(reply.statusCode ?? 502, result);
        reply.on("error", () => response.destroy());
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, client, head) => {
    const outgoing = headers(request);
    if (!outgoing) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = NodeHttp.request(new URL(request.url ?? "/", origin), { headers: outgoing });
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("response", (reply) => {
      reply.resume();
      client.end(
        `HTTP/1.1 ${reply.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    upstream.on("upgrade", (reply, remote, remoteHead) => {
      sockets.add(remote);
      remote.once("close", () => {
        sockets.delete(remote);
        client.destroy();
      });
      remote.on("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      client.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers)
          .flatMap(([key, value]) =>
            Array.isArray(value)
              ? value.map((entry) => `${key}: ${entry}`)
              : value === undefined
                ? []
                : [`${key}: ${value}`],
          )
          .join("\r\n")}\r\n\r\n`,
      );
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway address");
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    setPublicOrigin: (value: string) => {
      publicOrigin = httpsOrigin(value);
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
