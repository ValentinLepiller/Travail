import { VoiceApiError } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as VoiceSessionService from "../voice/VoiceSessionService.ts";
import * as AgentDesktops from "../agentDesktops/AgentDesktops.ts";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

export class MaintenanceActivityError extends Schema.TaggedError<MaintenanceActivityError>()(
  "MaintenanceActivityError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not establish that the environment is idle.";
  }
}

export class MaintenanceActivity extends Context.Service<
  MaintenanceActivity,
  { readonly read: Effect.Effect<RuntimeAdmission.Activity, MaintenanceActivityError> }
>()("t3/maintenance/MaintenanceActivity") {}

const isMaintenanceActivityError = Schema.is(MaintenanceActivityError);
const ActivityCount = Schema.Array(
  Schema.Struct({ activeWork: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
);
const decodeCount = Schema.decodeUnknownEffect(ActivityCount);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const desktops = yield* AgentDesktops.AgentDesktops;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const voice = yield* VoiceSessionService.VoiceSessionService;
  const terminals = yield* TerminalManager.TerminalManager;
  const terminalCount = Effect.gen(function* () {
    let count: number | undefined;
    return yield* Effect.acquireUseRelease(
      terminals.subscribeMetadata((event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") {
            // Even an idle shell can start background work after a process check.
            // V1 refuses every live PTY; closed history does not keep the host busy.
            count = event.terminals.filter(
              (terminal) => terminal.status !== "exited" && terminal.status !== "error",
            ).length;
          }
        }),
      ),
      () =>
        count === undefined
          ? Effect.fail(
              new MaintenanceActivityError({ cause: "Terminal metadata snapshot unavailable." }),
            )
          : Effect.succeed(count),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
  });
  const read = Effect.gen(function* () {
    // API WebRTC calls bypass the host after credential minting. Until that path
    // has a lifetime lease, configured API voice makes an idle proof unavailable.
    const apiVoice = yield* voice.getCredentialStatus;
    if (apiVoice.configured) {
      return yield* new MaintenanceActivityError({
        cause: "Untracked external API voice is configured.",
      });
    }
    // Count all persisted work before allowing a stop. Terminal whitelists keep
    // unknown future statuses busy; absent tables or invalid counts fail closed.
    const rows = yield* sql`
      SELECT SUM(n) AS activeWork FROM (
        SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs
          WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_run_attempts
          WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'superseded')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_nodes
          WHERE status NOT IN ('idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_provider_turns
          WHERE status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests
          WHERE status NOT IN ('resolved', 'expired', 'cancelled')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_subagents
          WHERE status NOT IN ('idle', 'completed', 'failed', 'cancelled', 'interrupted')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_thread_launch_workflows
          WHERE status NOT IN ('completed', 'failed', 'cancelled')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_effect_outbox
          WHERE status NOT IN ('succeeded', 'failed', 'cancelled')
        UNION ALL SELECT COUNT(*) FROM orchestration_v2_projection_provider_sessions
          WHERE status NOT IN ('ready', 'stopped', 'error')
        UNION ALL SELECT COUNT(*) FROM provider_session_runtime
          WHERE status NOT IN ('stopped', 'error')
      )
    `;
    const counts = yield* decodeCount(rows);
    if (counts.length !== 1) return yield* new MaintenanceActivityError({ cause: counts });
    const state = yield* admission.snapshot;
    const activeDesktops = yield* desktops.activeCount;
    if (!Number.isSafeInteger(activeDesktops) || activeDesktops < 0)
      return yield* new MaintenanceActivityError({ cause: activeDesktops });
    return {
      activeWork:
        counts[0]!.activeWork +
        (yield* terminalCount) +
        (yield* providerSessions.pendingBackgroundWork),
      activeVoice: state.activeVoice,
      activeDesktops: Math.max(activeDesktops, state.activeDesktops),
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      isMaintenanceActivityError(cause) ? cause : new MaintenanceActivityError({ cause }),
    ),
  );
  return MaintenanceActivity.of({ read });
});

export const layer = Layer.effect(MaintenanceActivity, make);

/** This harness supports host-tracked Codex account calls only. */
export const allowExternalVoice = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const admission = yield* Effect.serviceOption(RuntimeAdmission.RuntimeAdmission);
    if (Option.isSome(admission)) {
      return yield* new VoiceApiError({
        reason: "upstream_unavailable",
        message:
          "API voice is disabled in this native-account harness. Choose Codex account voice.",
      });
    }
    return yield* effect;
  });
