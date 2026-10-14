// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Private local supervisor, no credential logging.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { makeCloudflaredRelayClient } from "@t3tools/shared/relayClient";
import { decodeRemoteConfig, cloudflaredArguments, type RemoteConfig } from "./config.ts";
import { assertMtAuth, openGateway } from "./gateway.ts";

export async function startRemote(input: RemoteConfig, signal?: AbortSignal) {
  const config = decodeRemoteConfig(input);
  if (new URL(config.origin).port === "3773" && config.sharedOriginApproved !== true)
    throw new Error("Shared port 3773 requires parent coordination and sharedOriginApproved=true");
  signal?.throwIfAborted();
  if (config.mode === "named") {
    let credentials: unknown;
    try {
      const stat = await NodeFSP.stat(config.credentialsFile!);
      if ((stat.mode & 0o077) !== 0 || stat.size > 64_000)
        throw new Error("Invalid private credentials file");
      credentials = JSON.parse(await NodeFSP.readFile(config.credentialsFile!, "utf8"));
    } catch {
      // JSON parser diagnostics can include the credential input.
      throw new Error("Cannot read valid private Cloudflare tunnel credentials");
    }
    if (
      !credentials ||
      typeof credentials !== "object" ||
      !("TunnelID" in credentials) ||
      credentials.TunnelID !== config.tunnelId
    )
      throw new Error("Tunnel credentials do not match the configured UUID");
  }
  const executable = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeCloudflaredRelayClient({ baseDir: config.directory });
      return yield* client.resolve;
    }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
  );
  if (executable.status !== "available")
    throw new Error(
      "cloudflared is unavailable; configure T3CODE_CLOUDFLARED_PATH or install the CLI",
    );
  await assertMtAuth(config.origin, config.environmentId);
  await NodeFSP.mkdir(config.directory, { recursive: true, mode: 0o700 });
  const file = NodePath.join(config.directory, "cloudflared.json");
  const local = await openGateway(
    config.origin,
    config.proxyPort,
    config.mode === "named" ? `https://${config.hostname}` : undefined,
  );
  const tunnelConfig =
    config.mode === "named"
      ? {
          tunnel: config.tunnelId,
          "credentials-file": config.credentialsFile,
          ingress: [
            { hostname: config.hostname, service: `http://127.0.0.1:${local.port}` },
            { service: "http_status:404" },
          ],
        }
      : {};
  try {
    await NodeFSP.writeFile(file, JSON.stringify(tunnelConfig), { mode: 0o600 });
  } catch (error) {
    await local.close();
    throw error;
  }
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("TUNNEL_") || key === "NO_TLS_VERIFY") delete env[key];
  const child = NodeChildProcess.spawn(
    executable.executablePath,
    cloudflaredArguments(config, file),
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let ready = false;
  let pending = "";
  const completion = new Promise<number>((resolve) =>
    child.once("close", (code) => resolve(code ?? 1)),
  );
  let origin: string | undefined =
    config.mode === "named" ? `https://${config.hostname}` : undefined;
  const address = Promise.withResolvers<string>();
  const timer = setTimeout(
    () => address.reject(new Error("Cloudflare did not initialize within 45 seconds")),
    45_000,
  );
  const parse = (chunk: Buffer) => {
    pending = (pending + chunk.toString("utf8")).slice(-8192);
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(pending);
    if (config.mode === "quick" && match) {
      origin = match[0];
      local.setPublicOrigin(origin);
    }
    if (origin && /Registered tunnel connection/.test(pending) && !ready) {
      ready = true;
      clearTimeout(timer);
      address.resolve(origin);
    }
  };
  child.stdout.on("data", parse);
  child.stderr.on("data", parse);
  child.once("error", () => address.reject(new Error("Cannot start cloudflared")));
  child.once("close", () => {
    clearTimeout(timer);
    address.reject(new Error("Cloudflare tunnel stopped before initialization"));
    void local.close();
  });
  let closing: Promise<void> | undefined;
  function stop() {
    closing ??= (async () => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await completion;
      clearTimeout(force);
      await local.close();
    })();
    return closing;
  }
  const abort = () => {
    address.reject(new Error("Tunnel start cancelled"));
    void stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal?.removeEventListener("abort", abort));
  if (signal?.aborted) abort();
  try {
    return { origin: await address.promise, stop, completion };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Prepare only. Enabling the unit is a separate operator action after shared-host validation. */
export function remoteUnit(node: string, script: string, configFile: string) {
  const quote = (value: string) => JSON.stringify(value.replaceAll("%", "%%"));
  return `[Unit]\nDescription=MT authenticated HTTPS tunnel\nAfter=mt-harness.service network-online.target\nBindsTo=mt-harness.service\n\n[Service]\nType=simple\nExecStart=${quote(node)} ${quote(script)} run ${quote(configFile)}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=mt-harness.service\n`;
}
