// @effect-diagnostics nodeBuiltinImport:off - Independent remote operations boundary.
import * as NodePath from "node:path";

export interface RemoteConfig {
  origin: string;
  environmentId: string;
  proxyPort: number;
  mode: "quick" | "named";
  hostname?: string;
  tunnelId?: string;
  credentialsFile?: string;
  directory: string;
  sharedOriginApproved: boolean;
}
export function decodeRemoteConfig(value: unknown): RemoteConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid remote config");
  const config = value as RemoteConfig;
  const origin = new URL(config.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.port
  )
    throw new Error("Origin must be an explicit loopback HTTP port");
  if (
    !Number.isInteger(config.proxyPort) ||
    config.proxyPort < 1 ||
    config.proxyPort > 65535 ||
    Number(origin.port) === config.proxyPort
  )
    throw new Error("Invalid dedicated proxy port");
  if (
    typeof config.environmentId !== "string" ||
    !config.environmentId ||
    !NodePath.isAbsolute(config.directory)
  )
    throw new Error("Expected environment identity and absolute remote state directory");
  if (config.mode !== "quick" && config.mode !== "named")
    throw new Error("Remote mode must be quick or named");
  if (
    config.mode === "named" &&
    (!config.hostname ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(config.hostname) ||
      !config.tunnelId ||
      !/^[a-f0-9-]{36}$/i.test(config.tunnelId) ||
      !config.credentialsFile ||
      !NodePath.isAbsolute(config.credentialsFile))
  )
    throw new Error(
      "Named tunnel requires the approved hostname, tunnel UUID and absolute credentials file",
    );
  return config;
}
export function httpsOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Expected a public HTTPS origin without credentials or path");
  return url.origin;
}

export function cloudflaredArguments(config: RemoteConfig, configFile: string) {
  const common = [
    "tunnel",
    "--config",
    configFile,
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--metrics",
    "127.0.0.1:0",
    "--loglevel",
    "info",
  ];
  return config.mode === "quick"
    ? [...common, "--url", `http://127.0.0.1:${config.proxyPort}`]
    : [...common, "run", config.tunnelId!];
}
