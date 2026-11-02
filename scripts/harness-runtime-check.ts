#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Durable bounded regression probes; no model tours or connector writes.
import * as NodePath from "node:path";
import { run } from "./lib/runtime-maintenance/commands.ts";
import { requiredUsages, type Usage } from "./lib/runtime-maintenance/promotion.ts";

const usage = process.argv[2] as Usage;
if (!requiredUsages.includes(usage)) throw new Error("Expected a maintenance usage name");
const tests: Record<Usage, readonly string[]> = {
  agents: [
    "scripts/lib/harness-home.test.ts",
    "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
  ],
  delegation: ["apps/server/src/orchestration-v2/SubagentProjection.test.ts"],
  connectors: ["scripts/connectors/adapter.test.ts", "scripts/connectors/native.test.ts"],
  voice: [
    "apps/server/src/voice/CodexVoiceSession.test.ts",
    "apps/server/src/voice/VoiceSessionService.test.ts",
    "apps/server/src/voice/voiceDelegation.test.ts",
  ],
  remote: [
    "scripts/lib/harness-remote/gateway.test.ts",
    "apps/server/src/auth/EnvironmentAuthAdmin.test.ts",
  ],
  desktops: [
    "apps/server/src/agentDesktops/AgentDesktops.test.ts",
    "apps/server/src/agentDesktops/AgentDesktopHttp.test.ts",
  ],
  scheduling: [
    "apps/server/src/scheduledTasks/Schedule.test.ts",
    "apps/server/src/scheduling/Scheduler.integration.test.ts",
    "scripts/lib/runtime-maintenance/promotion.test.ts",
    "scripts/lib/runtime-maintenance/daily.test.ts",
  ],
};
const environment: NodeJS.ProcessEnv = { ...process.env, T3_TEST_AGENT_DESKTOPS: "1" };
try {
  await run(
    {
      program: NodePath.join(process.cwd(), "node_modules", ".bin", "vp"),
      args: ["test", "run", ...tests[usage]],
    },
    process.cwd(),
    1_200_000,
    environment,
  );
  if (usage === "delegation")
    await run(
      {
        program: process.execPath,
        args: [
          "scripts/agent-smoke/run.mjs",
          "--codex",
          "codex",
          "--home",
          environment.CODEX_HOME ??
            NodePath.join(process.env.HARNESS_HOME ?? ".t3/validation", "codex"),
          "--out",
          ".logs/harness/maintenance-agents",
        ],
      },
      process.cwd(),
      200_000,
      environment,
    );
  if (usage === "connectors")
    await run(
      { program: process.execPath, args: ["scripts/connectors/probe.ts"] },
      process.cwd(),
      120_000,
      environment,
    );
  if (usage === "scheduling")
    await run(
      { program: process.execPath, args: ["ops/harness/runtime-proof.mjs"] },
      process.cwd(),
      180_000,
      environment,
    );
  if (usage === "scheduling")
    await run(
      { program: process.execPath, args: ["ops/harness/old-release-gates.mjs"] },
      process.cwd(),
      // Three server lifecycles include graceful shutdown as well as startup.
      240_000,
      environment,
    );
  console.log(
    JSON.stringify({
      usage,
      regressionChecks: "passed",
      live:
        usage === "delegation" ||
        usage === "connectors" ||
        usage === "desktops" ||
        usage === "scheduling",
    }),
  );
} catch (error) {
  console.error(
    `Maintenance ${usage} failed: ${error instanceof Error ? error.message : "unknown failure"}`,
  );
  process.exitCode = 1;
}
