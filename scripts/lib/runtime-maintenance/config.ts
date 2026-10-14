// @effect-diagnostics preferSchemaOverJson:off - Builtin-only controller must recover even if MT dependencies cannot load.
import type { Command } from "./commands.ts";

export interface RuntimeConfig {
  source: string;
  home: string;
  operations: string;
  port: number;
  timezone: string;
  environmentId: string;
  nativeCodex: string;
  path: string;
  prepareUpdates: boolean;
  adaptWithAgent: boolean;
  promoteValidated: boolean;
  agentTimeoutMs: number;
  commandTimeoutMs: number;
  mt: { url: string; ref: string };
  t3: { url: string; ref: string };
  checks: Record<string, readonly Command[]>;
  postPromotionChecks: readonly Command[];
}

export function decodeConfig(value: unknown): RuntimeConfig {
  if (typeof value !== "object" || value === null) throw new Error("Invalid runtime config");
  const config = value as RuntimeConfig;
  for (const name of [
    "source",
    "home",
    "operations",
    "timezone",
    "environmentId",
    "nativeCodex",
    "path",
  ] as const) {
    if (typeof config[name] !== "string" || config[name].length === 0)
      throw new Error(`Invalid config ${name}`);
  }
  for (const name of ["prepareUpdates", "adaptWithAgent", "promoteValidated"] as const) {
    if (typeof config[name] !== "boolean") throw new Error(`Invalid config ${name}`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("Invalid runtime port");
  for (const timeout of [config.commandTimeoutMs, config.agentTimeoutMs]) {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1_800_000)
      throw new Error("Timeout must be between 1ms and 30min");
  }
  new Intl.DateTimeFormat("en", { timeZone: config.timezone }).format();
  for (const remote of [config.mt, config.t3]) {
    if (!remote || !remote.url.startsWith("https://") || !remote.ref?.startsWith("refs/heads/"))
      throw new Error("Invalid upstream");
  }
  if (
    !config.checks ||
    typeof config.checks !== "object" ||
    !Array.isArray(config.postPromotionChecks)
  )
    throw new Error("Invalid checks");
  for (const checks of [...Object.values(config.checks), config.postPromotionChecks]) {
    if (!Array.isArray(checks)) throw new Error("Invalid checks");
    for (const check of checks) {
      if (
        !check ||
        typeof check.program !== "string" ||
        !Array.isArray(check.args) ||
        check.args.some((arg: unknown) => typeof arg !== "string")
      )
        throw new Error("Invalid command");
    }
  }
  return config;
}
