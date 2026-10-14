import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

const idle = () => Effect.succeed({ activeWork: 0, activeVoice: 0, activeDesktops: 0 });
const registerHooks = (gate: RuntimeAdmission.RuntimeAdmission["Service"]) =>
  Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (hook) => gate.registerHook(hook));

it.effect("refuses maintenance when any required transport hook is missing", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    yield* gate.registerHook("orchestration");
    const error = yield* gate.quiesce("update-1", idle).pipe(Effect.flip);
    expect(error.code).toBe("hooks_missing");
    expect((yield* gate.snapshot).operationId).toBeNull();
    expect(yield* gate.admit(Effect.succeed("still open"))).toBe("still open");
  }),
);

it.effect(
  "keeps admission open when work is in flight and releases nested reservations on failure",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      yield* gate.admit(
        Effect.gen(function* () {
          expect((yield* gate.snapshot).inFlight).toBe(1);
          const busy = yield* gate.quiesce("update-1", idle).pipe(Effect.flip);
          expect(busy.code).toBe("busy");
          expect((yield* gate.snapshot).operationId).toBeNull();
          const failure = yield* gate
            .admit(
              Effect.gen(function* () {
                expect((yield* gate.snapshot).inFlight).toBe(2);
                return yield* Effect.fail("application error");
              }),
            )
            .pipe(Effect.flip);
          expect(failure).toBe("application error");
        }),
      );
      expect((yield* gate.snapshot).inFlight).toBe(0);
    }),
);

it.effect("blocks new work during the durable probe, then reopens on busy or invalid results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<RuntimeAdmission.Activity>();
      const attempt = yield* gate
        .quiesce("update-1", () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const denied = yield* gate.admit(Effect.succeed("new work")).pipe(Effect.flip);
      expect(denied.code).toBe("maintenance_active");
      yield* Deferred.succeed(finish, { activeWork: 1, activeVoice: 0, activeDesktops: 0 });
      const busy = yield* Fiber.join(attempt).pipe(Effect.flip);
      expect(busy.code).toBe("busy");
      expect((yield* gate.snapshot).operationId).toBeNull();
      const invalid = yield* gate
        .quiesce("update-2", () =>
          Effect.succeed({ activeWork: Number.NaN, activeVoice: 0, activeDesktops: 0 }),
        )
        .pipe(Effect.flip);
      expect(invalid.code).toBe("invalid_probe");
      expect((yield* gate.snapshot).operationId).toBeNull();
    }),
  ),
);

it.effect(
  "keeps voice and desktop owners uninterrupted on refused maintenance and releases resources once",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      for (const kind of ["voice", "desktop"] as const) {
        const release = yield* gate.reserve(kind);
        const busy = yield* gate.quiesce(`update-${kind}`, idle).pipe(Effect.flip);
        expect(busy.code).toBe("busy");
        expect((yield* gate.snapshot).operationId).toBeNull();
        yield* gate.admit(Effect.void);
        yield* release;
        yield* release;
      }
      expect(yield* gate.snapshot).toMatchObject({
        activeVoice: 0,
        activeDesktops: 0,
        inFlight: 0,
      });
    }),
);

it.effect(
  "retains a successful lease until matching release and rejects a stale owner's release",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      const closed = yield* gate.quiesce("update-1", idle);
      expect(closed).toEqual({
        operationId: "update-1",
        quiesced: true,
        activeWork: 0,
        activeVoice: 0,
        activeDesktops: 0,
      });
      expect(
        yield* gate.quiesce("update-1", () => Effect.die("A retry must retain its lease")),
      ).toEqual(closed);
      const conflict = yield* gate.release("update-0").pipe(Effect.flip);
      expect(conflict.code).toBe("operation_conflict");
      expect((yield* gate.admit(Effect.void).pipe(Effect.flip)).code).toBe("maintenance_active");
      yield* gate.release("update-1");
      yield* gate.release("update-1");
      yield* gate.quiesce("update-2", idle);
      expect((yield* gate.release("update-1").pipe(Effect.flip)).code).toBe("operation_conflict");
      yield* gate.release("update-2");
      yield* gate.admit(Effect.void);
    }),
);

it.effect("does not let a detached child reuse an admission after its owner finished", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      const resume = yield* Deferred.make<void>();
      const child = yield* gate.admit(
        Deferred.await(resume).pipe(Effect.andThen(gate.admit(Effect.void)), Effect.forkScoped),
      );
      yield* gate.quiesce("update-1", idle);
      yield* Deferred.succeed(resume, undefined);
      const rejected = yield* Fiber.join(child).pipe(Effect.flip);
      expect(rejected.code).toBe("maintenance_active");
      expect((yield* gate.snapshot).inFlight).toBe(0);
    }),
  ),
);

it.effect("reopens admission if its durable probe fails or is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      expect(
        yield* gate.quiesce("update-1", () => Effect.fail("probe failed")).pipe(Effect.flip),
      ).toBe("probe failed");
      const entered = yield* Deferred.make<void>();
      const attempt = yield* gate
        .quiesce("update-2", () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(attempt);
      expect((yield* gate.snapshot).operationId).toBeNull();
      yield* gate.admit(Effect.void);
    }),
  ),
);

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Metadata-only maintenance test must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "runtime-admission" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
).pipe(Layer.provideMerge(RuntimeAdmission.layer));

it.effect(
  "replays accepted commands while closed, drains Stop and retries refused mutations without a rejected receipt",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      expect((yield* gate.snapshot).hooks).toContain("orchestration");
      yield* registerHooks(gate);
      const threadId = ThreadId.make("thread:maintenance-test");
      const create = {
        type: "thread.create",
        commandId: CommandId.make("create:maintenance-test"),
        threadId,
        projectId: ProjectId.make("project:maintenance-test"),
        title: "Before",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      } as const;
      const accepted = yield* orchestrator.dispatch(create);
      yield* gate.quiesce("update-1", idle);
      const replay = yield* orchestrator.dispatch(create);
      expect(replay.sequence).toBe(accepted.sequence);
      const rename = {
        type: "thread.metadata.update",
        threadId,
        commandId: CommandId.make("rename:maintenance-test"),
        title: "After",
      } as const;
      const denied = yield* orchestrator
        .dispatch(rename)
        .pipe(
          Effect.provideService(RuntimeAdmission.RuntimeAdmission, yield* RuntimeAdmission.make),
          Effect.flip,
        );
      expect(denied._tag).toBe("OrchestratorCommandRejectedError");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        threadId,
        commandId: CommandId.make("stop:maintenance-test"),
      });
      yield* gate.release("update-1");
      yield* orchestrator.dispatch(rename);
      expect((yield* orchestrator.getThreadShell(threadId))?.title).toBe("After");
      expect((yield* gate.snapshot).inFlight).toBe(0);

      yield* gate.quiesce("update-2", idle);
      const releaseContinuation = yield* Deferred.make<void>();
      const continuation = {
        type: "message.dispatch",
        commandId: CommandId.make("continuation:maintenance-test"),
        messageId: MessageId.make("message:deferred-continuation"),
        threadId,
        text: "Background work finished while maintenance is closed.",
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Finished",
        },
        attachments: [],
        createdBy: "agent",
        creationSource: "provider",
        dispatchMode: { type: "queue_after_active" },
      } as const;
      const deferred = yield* Deferred.await(releaseContinuation).pipe(
        Effect.andThen(orchestrator.dispatch(continuation)),
        Effect.forkScoped,
      );
      yield* Deferred.succeed(releaseContinuation, undefined);
      expect((yield* Fiber.join(deferred).pipe(Effect.flip))._tag).toBe(
        "OrchestratorCommandRejectedError",
      );
      const unchanged = yield* orchestrator.getThreadProjection(threadId);
      expect(unchanged.runs).toHaveLength(0);
      expect(unchanged.messages).toHaveLength(0);
      yield* gate.release("update-2");
      yield* orchestrator.dispatch(continuation);
      const resumed = yield* orchestrator.getThreadProjection(threadId);
      expect(resumed.runs).toHaveLength(1);
      expect(resumed.messages).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layerOrchestrator)),
);
