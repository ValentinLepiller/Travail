import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import type { TerminalSummary } from "@t3tools/contracts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as VoiceSessionService from "../voice/VoiceSessionService.ts";
import * as AgentDesktops from "../agentDesktops/AgentDesktops.ts";
import * as MaintenanceActivity from "./MaintenanceActivity.ts";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

const tables = [
  ["orchestration_v2_projection_runs", "completed"],
  ["orchestration_v2_projection_run_attempts", "completed"],
  ["orchestration_v2_projection_nodes", "completed"],
  ["orchestration_v2_projection_provider_turns", "completed"],
  ["orchestration_v2_projection_runtime_requests", "resolved"],
  ["orchestration_v2_projection_subagents", "completed"],
  ["orchestration_v2_thread_launch_workflows", "completed"],
  ["orchestration_v2_effect_outbox", "succeeded"],
  ["orchestration_v2_projection_provider_sessions", "ready"],
  ["provider_session_runtime", "stopped"],
] as const;
const desktops = Layer.succeed(AgentDesktops.AgentDesktops, {
  activeCount: Effect.succeed(0),
} as AgentDesktops.AgentDesktops["Service"]);
const layerForVoice = (
  configured: boolean,
  terminalStatuses: ReadonlyArray<TerminalSummary["status"]> = [],
  backgroundWork = 0,
) =>
  MaintenanceActivity.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        pendingBackgroundWork: Effect.succeed(backgroundWork),
      }),
    ),
    Layer.provide(
      Layer.succeed(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribeMetadata"]>[0],
        ) =>
          listener({
            type: "snapshot",
            terminals: terminalStatuses.map(
              (status) => ({ status, hasRunningSubprocess: false }) as TerminalSummary,
            ),
          }).pipe(Effect.as(() => {})),
      } as unknown as TerminalManager.TerminalManager["Service"]),
    ),
    Layer.provideMerge(RuntimeAdmission.layer),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(desktops),
    Layer.provide(
      Layer.succeed(VoiceSessionService.VoiceSessionService, {
        getCredentialStatus: Effect.succeed({ configured }),
      } as unknown as VoiceSessionService.VoiceSessionService["Service"]),
    ),
  );
const layer = layerForVoice(false);
const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Only the status projection is needed by this read-only query contract.
  for (const [name] of tables) {
    const fields =
      name === "orchestration_v2_projection_runs"
        ? ", run_id TEXT"
        : name === "orchestration_v2_projection_nodes"
          ? ", run_id TEXT, kind TEXT"
          : "";
    yield* sql.unsafe(`CREATE TABLE ${name} (status TEXT NOT NULL${fields})`);
  }
});

it.effect(
  "counts queued, runtime, provider, workflow, subagent and outbox activity, including unknown statuses",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activity = yield* MaintenanceActivity.MaintenanceActivity;
      yield* createTables;
      for (const [name, terminal] of tables)
        yield* sql.unsafe(`INSERT INTO ${name}(status) VALUES (?)`, [terminal]);
      expect(yield* activity.read).toEqual({ activeWork: 0, activeVoice: 0, activeDesktops: 0 });
      for (const [name] of tables) {
        yield* sql.unsafe(`INSERT INTO ${name}(status) VALUES (?)`, ["future_unknown_state"]);
        expect((yield* activity.read).activeWork).toBe(1);
        yield* sql.unsafe(`DELETE FROM ${name} WHERE status = ?`, ["future_unknown_state"]);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_runs(status) VALUES ('queued')`;
      yield* sql`INSERT INTO orchestration_v2_effect_outbox(status) VALUES ('pending')`;
      expect((yield* activity.read).activeWork).toBe(2);
    }).pipe(Effect.provide(layer)),
);

it.effect("never reports idle when the durable schema cannot be read", () =>
  Effect.gen(function* () {
    const activity = yield* MaintenanceActivity.MaintenanceActivity;
    const gate = yield* RuntimeAdmission.RuntimeAdmission;
    yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
    const error = yield* gate.quiesce("update-1", () => activity.read).pipe(Effect.flip);
    expect(error._tag).toBe("MaintenanceActivityError");
    expect((yield* gate.snapshot).operationId).toBeNull();
    expect(yield* gate.admit(Effect.succeed("open"))).toBe("open");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps the voice reservation visible for the entire call lifetime", () =>
  Effect.gen(function* () {
    const activity = yield* MaintenanceActivity.MaintenanceActivity;
    const gate = yield* RuntimeAdmission.RuntimeAdmission;
    yield* createTables;
    const release = yield* gate.reserve("voice");
    expect((yield* activity.read).activeVoice).toBe(1);
    yield* release;
    yield* release;
    expect((yield* activity.read).activeVoice).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("fails closed when configured API voice has no host lifetime tracking", () =>
  Effect.gen(function* () {
    const activity = yield* MaintenanceActivity.MaintenanceActivity;
    yield* createTables;
    const error = yield* activity.read.pipe(Effect.flip);
    expect(error._tag).toBe("MaintenanceActivityError");
  }).pipe(Effect.provide(layerForVoice(true))),
);

it.effect("refuses maintenance for an open idle PTY and ignores exited terminal history", () =>
  Effect.gen(function* () {
    const activity = yield* MaintenanceActivity.MaintenanceActivity;
    yield* createTables;
    expect((yield* activity.read).activeWork).toBe(1);
  }).pipe(Effect.provide(layerForVoice(false, ["running", "exited", "error"]))),
);

it.effect("refuses API session minting in the maintenable harness before any API call", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    let minted = 0;
    const mint = Effect.sync(() => {
      minted++;
      return "synthetic credential";
    });
    const error = yield* MaintenanceActivity.allowExternalVoice(mint).pipe(
      Effect.provideService(RuntimeAdmission.RuntimeAdmission, gate),
      Effect.flip,
    );
    expect(error._tag).toBe("VoiceApiError");
    expect(error.message).toContain("Choose Codex account voice");
    expect(minted).toBe(0);
    expect(yield* MaintenanceActivity.allowExternalVoice(mint)).toBe("synthetic credential");
  }),
);

it.effect(
  "refuses maintenance for provider-owned background work after its root run completed",
  () =>
    Effect.gen(function* () {
      const activity = yield* MaintenanceActivity.MaintenanceActivity;
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      yield* createTables;
      yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
      expect((yield* activity.read).activeWork).toBe(1);
      expect(yield* gate.quiesce("update", () => activity.read).pipe(Effect.flip)).toMatchObject({
        code: "busy",
      });
      expect((yield* gate.snapshot).operationId).toBeNull();
    }).pipe(Effect.provide(layerForVoice(false, [], 1))),
);

it.effect(
  "unfinished historical plans do not block maintenance, while executable and unowned nodes remain busy",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activity = yield* MaintenanceActivity.MaintenanceActivity;
      yield* createTables;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, status) VALUES ('finished', 'completed')`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes (run_id, kind, status) VALUES ('finished', 'todo_list', 'running')`;
      expect((yield* activity.read).activeWork).toBe(0);
      yield* sql`UPDATE orchestration_v2_projection_nodes SET kind = 'tool_call'`;
      expect((yield* activity.read).activeWork).toBe(1);
      yield* sql`UPDATE orchestration_v2_projection_nodes SET kind = 'todo_list', run_id = 'missing'`;
      expect((yield* activity.read).activeWork).toBe(1);
      yield* sql`UPDATE orchestration_v2_projection_nodes SET run_id = 'finished', kind = NULL`;
      expect((yield* activity.read).activeWork).toBe(1);
      yield* sql`UPDATE orchestration_v2_projection_nodes SET kind = 'todo_list'`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running'`;
      expect((yield* activity.read).activeWork).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer)),
);
