// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - Bounded operational readiness retries, not test synchronization.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { withProbeSession } from "../runtime-maintenance/auth.ts";
import type { RuntimeConfig } from "../runtime-maintenance/config.ts";
import { httpsOrigin, type RemoteConfig } from "./config.ts";
import { assertMtAuth, webSocketStatus } from "./gateway.ts";

async function enabled() {
  return new Promise<boolean>((resolve, reject) => {
    NodeChildProcess.execFile(
      "systemctl",
      ["--user", "is-enabled", "mt-harness-remote.service"],
      { timeout: 5_000, maxBuffer: 4_096 },
      (error, stdout) => {
        const state = stdout.trim();
        if (state === "disabled") resolve(false);
        else if (!error && ["enabled", "enabled-runtime"].includes(state)) resolve(true);
        else reject(new Error("Cannot determine remote service enablement"));
      },
    );
  });
}

export async function sessionState(origin: string, token: string, protocolVersion: number) {
  const response = await fetch(new URL("/api/auth/session", origin), {
    headers: {
      authorization: `Bearer ${token}`,
      "x-t3-orchestration-protocol": String(protocolVersion),
    },
    signal: AbortSignal.timeout(5_000),
  });
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("authenticated" in value) ||
    typeof value.authenticated !== "boolean"
  )
    throw new Error("Invalid auth session response");
  return { status: response.status, authenticated: value.authenticated };
}

/** A disabled unit is intentional; an enabled but unavailable tunnel must fail promotion health. */
export async function healthRemote(config: RemoteConfig, runtime?: RuntimeConfig) {
  if (new URL(config.origin).port === "3773" && !config.sharedOriginApproved)
    return { required: false, reason: "publication-not-approved" };
  if (!(await enabled())) return { required: false, reason: "unit-disabled" };
  if (
    runtime &&
    (runtime.environmentId !== config.environmentId ||
      String(runtime.port) !== new URL(config.origin).port)
  )
    throw new Error("Remote and runtime health configurations identify different environments");
  const deadline = Date.now() + 45_000;
  let lastFailure = "Tunnel status is unavailable";
  do {
    try {
      const status: unknown = JSON.parse(
        await NodeFSP.readFile(NodePath.join(config.directory, "status.json"), "utf8"),
      );
      if (
        !status ||
        typeof status !== "object" ||
        !("origin" in status) ||
        typeof status.origin !== "string" ||
        ("stopped" in status && status.stopped === true)
      )
        throw new Error("Tunnel status is unavailable");
      const origin = httpsOrigin(status.origin);
      const protocolVersion = await assertMtAuth(origin, config.environmentId);
      let token: string | undefined;
      if (runtime) {
        await withProbeSession(runtime, "orchestration:read", async (credential) => {
          token = credential;
          const session = await sessionState(origin, credential, protocolVersion);
          if (session.status !== 200 || !session.authenticated)
            throw new Error("Authenticated HTTPS probe failed");
          const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
            method: "POST",
            headers: { authorization: `Bearer ${credential}` },
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Cannot issue authenticated HTTPS WebSocket ticket");
          }
          const ticket = (await response.json()) as { ticket?: unknown };
          if (
            typeof ticket?.ticket !== "string" ||
            (await webSocketStatus(
              origin,
              { origin },
              { protocolVersion, ticket: ticket.ticket },
            )) !== 101
          )
            throw new Error("Authenticated HTTPS WebSocket probe failed");
        });
        if (typeof token !== "string") throw new Error("Temporary probe session was not revoked");
        const revoked = await sessionState(origin, token, protocolVersion);
        const deniedTicket = await fetch(new URL("/api/auth/websocket-ticket", origin), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        await deniedTicket.body?.cancel();
        if (revoked.authenticated || deniedTicket.status !== 401)
          throw new Error("Temporary probe session was not revoked");
      }
      return {
        required: true,
        healthy: true,
        origin,
        protocolVersion,
        anonymousHttp: 401,
        anonymousWebSocket: 401,
        authenticatedProbe: Boolean(runtime),
        temporarySessionRevoked: Boolean(runtime),
      };
    } catch (error) {
      lastFailure =
        error instanceof Error &&
        [
          "Tunnel status is unavailable",
          "Authenticated HTTPS probe failed",
          "Invalid auth session response",
          "Cannot issue authenticated HTTPS WebSocket ticket",
          "Authenticated HTTPS WebSocket probe failed",
          "Temporary probe session was not revoked",
        ].includes(error.message)
          ? error.message
          : "Tunnel transport, identity or probe CLI is unavailable";
      // Status replacement and Cloudflare registration race the host restart; never log bearer/ticket diagnostics.
    }
    await NodeTimersPromises.setTimeout(1_000);
  } while (Date.now() < deadline);
  throw new Error(`Enabled HTTPS tunnel failed its post-restart health check: ${lastFailure}`);
}
