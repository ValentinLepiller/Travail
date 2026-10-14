// @effect-diagnostics nodeBuiltinImport:off - Local temporary bearer lifetime; secrets never enter command logs.
import * as NodePath from "node:path";
import { run } from "./commands.ts";
import type { RuntimeConfig } from "./config.ts";
import { currentRelease } from "./state.ts";

export async function withProbeSession<T>(
  config: RuntimeConfig,
  scope: string,
  use: (token: string) => Promise<T>,
): Promise<T> {
  const root = await currentRelease(config.operations);
  const cli = NodePath.join(root, "apps/server/dist/bin.mjs");
  const issued = await run(
    {
      program: process.execPath,
      args: [
        cli,
        "auth",
        "session",
        "issue",
        "--base-dir",
        config.home,
        "--scope",
        scope,
        "--subject",
        "harness-maintenance-probe",
        "--label",
        "MT maintenance probe",
        "--ttl",
        "5m",
        "--json",
      ],
    },
    root,
  );
  let session: { sessionId: string; token: string };
  try {
    session = JSON.parse(issued) as typeof session;
  } catch {
    throw new Error("Invalid temporary session payload");
  }
  if (typeof session.token !== "string" || typeof session.sessionId !== "string")
    throw new Error("Invalid temporary session");
  try {
    return await use(session.token);
  } finally {
    await run(
      {
        program: process.execPath,
        args: [cli, "auth", "session", "revoke", session.sessionId, "--base-dir", config.home],
      },
      root,
    );
  }
}
