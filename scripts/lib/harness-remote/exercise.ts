// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalTimers:off - Real transport proof on an explicitly isolated fixture only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";

const fixture = JSON.parse(await NodeFSP.readFile(".logs/harness/remote/fixture.json", "utf8")) as {
  origin: string;
  home: string;
  dist: string;
  sharedPortPublished: boolean;
};
if (
  fixture.sharedPortPublished !== false ||
  !fixture.home.includes("/.t3/harness-remote-fixtures/proof-")
)
  throw new Error("This proof accepts isolated fixture state only");
async function cli(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(fixture.dist, "bin.mjs"), "auth", ...args, "--base-dir", fixture.home],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    child.once("error", () => reject(new Error("Fixture auth CLI failed")));
    child.once("close", (code) =>
      code === 0 ? resolve(text) : reject(new Error("Fixture auth operation failed")),
    );
  });
}
function maskedText(text: string) {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error("Fixture RPC exceeds short-frame limit");
  const mask = NodeCrypto.randomBytes(4);
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | payload.length]),
    mask,
    Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!)),
  ]);
}
function socketProof(cookie?: string, receive = false) {
  const url = new URL("/ws", fixture.origin);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return new Promise<{ status: number; tlsVerified?: boolean; serverFrameReceived?: boolean }>(
    (resolve, reject) => {
      const request = NodeHttps.request(url, {
        rejectUnauthorized: true,
        headers: {
          ...(cookie ? { cookie } : {}),
          origin: fixture.origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
        },
      });
      request.setTimeout(10_000, () =>
        request.destroy(new Error("HTTPS WebSocket fixture timed out")),
      );
      request.on("error", reject);
      request.on("response", (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on("upgrade", (_response, socket, head) => {
        if (!receive) {
          socket.destroy();
          resolve({ status: 101, tlsVerified: true });
          return;
        }
        socket.setTimeout(10_000, () => {
          socket.destroy();
          reject(new Error("No server WebSocket frame received"));
        });
        const gotFrame = (chunk: Buffer) => {
          if (chunk.length < 2) return;
          socket.destroy();
          resolve({ status: 101, tlsVerified: true, serverFrameReceived: true });
        };
        socket.once("data", gotFrame);
        socket.on("error", reject);
        socket.write(
          maskedText(
            JSON.stringify({
              _tag: "Request",
              id: "1",
              tag: "subscribeServerLifecycle",
              payload: {},
              headers: [],
            }),
          ),
        );
        if (head.length) gotFrame(head);
      });
      request.end();
    },
  );
}
const proof: Record<string, unknown> = {
  publicOrigin: fixture.origin,
  isolatedState: true,
  sharedPortPublished: false,
};
const issued = JSON.parse(
  await cli(["pairing", "create", "--ttl", "5m", "--label", "Remote transport fixture", "--json"]),
) as { credential: string };
const anonymous = await fetch(new URL("/api/orchestration/shell", fixture.origin));
proof.anonymousHttp = anonymous.status;
proof.anonymousWebSocket = await socketProof();
const exchange = await fetch(new URL("/api/auth/browser-session", fixture.origin), {
  method: "POST",
  headers: { "content-type": "application/json", origin: fixture.origin },
  body: JSON.stringify({ credential: issued.credential }),
});
if (exchange.status !== 200) throw new Error(`Pairing failed with status ${exchange.status}`);
const setCookie = exchange.headers.getSetCookie()[0];
if (!setCookie) throw new Error("Missing browser session cookie");
const cookie = setCookie.split(";", 1)[0]!;
proof.pairing = {
  status: exchange.status,
  secureCookie: /;\s*Secure/i.test(setCookie),
  httpOnly: /;\s*HttpOnly/i.test(setCookie),
};
proof.authenticatedHttp = (
  await fetch(new URL("/api/orchestration/shell", fixture.origin), {
    headers: {
      cookie,
      origin: fixture.origin,
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    },
  })
).status;
proof.authenticatedWebSocket = await socketProof(cookie, true);
const reuse = await fetch(new URL("/api/auth/browser-session", fixture.origin), {
  method: "POST",
  headers: { "content-type": "application/json", origin: fixture.origin },
  body: JSON.stringify({ credential: issued.credential }),
});
proof.consumedPairingStatus = reuse.status;
const sessions = JSON.parse(await cli(["session", "list", "--json"])) as {
  sessionId: string;
  method: string;
}[];
const browserSession = sessions.find((session) => session.method === "browser-session-cookie");
if (!browserSession) throw new Error("Missing fixture session to revoke");
await cli(["session", "revoke", browserSession.sessionId]);
proof.revokedHttp = (
  await fetch(new URL("/api/orchestration/shell", fixture.origin), {
    headers: {
      cookie,
      origin: fixture.origin,
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    },
  })
).status;
proof.revokedWebSocket = await socketProof(cookie);
await NodeFSP.writeFile(
  ".logs/harness/remote/transport-proof.json",
  JSON.stringify(proof, null, 2),
);
if (
  proof.anonymousHttp !== 401 ||
  proof.authenticatedHttp !== 200 ||
  proof.revokedHttp !== 401 ||
  (proof.revokedWebSocket as { status: number }).status !== 401
)
  throw new Error("Transport proof failed; inspect sanitized status counters");
console.log(JSON.stringify(proof, null, 2));
