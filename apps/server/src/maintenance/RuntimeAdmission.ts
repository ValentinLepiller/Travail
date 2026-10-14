import { RuntimeAdmissionError, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export const REQUIRED_HOOKS = [
  "orchestration",
  "mcp",
  "scheduler",
  "voice",
  "desktops",
  "rpc",
  "http",
] as const;
export type AdmissionHook = (typeof REQUIRED_HOOKS)[number];
export type ResourceKind = "voice" | "desktop" | "work";
export interface Activity {
  readonly activeWork: number;
  readonly activeVoice: number;
  readonly activeDesktops: number;
}

export { RuntimeAdmissionError } from "@t3tools/contracts";

interface AdmissionState {
  readonly operationId: string | null;
  readonly inFlight: number;
  readonly activeVoice: number;
  readonly activeDesktops: number;
  readonly hooks: ReadonlyArray<AdmissionHook>;
}

class AdmissionLease extends Context.Service<
  AdmissionLease,
  { readonly owner: object; readonly token: object }
>()("t3/maintenance/RuntimeAdmission/AdmissionLease") {}

export class RuntimeAdmission extends Context.Service<
  RuntimeAdmission,
  {
    readonly snapshot: Effect.Effect<AdmissionState>;
    readonly awaitOpen: Effect.Effect<void>;
    readonly registerHook: (name: AdmissionHook) => Effect.Effect<void>;
    readonly admit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RuntimeAdmissionError, R>;
    /** Keep this reservation until the actual voice call or private desktop lease ends. */
    readonly reserve: (
      kind: ResourceKind,
    ) => Effect.Effect<Effect.Effect<void>, RuntimeAdmissionError>;
    readonly quiesce: <E, R>(
      operationId: string,
      probe: () => Effect.Effect<Activity, E, R>,
    ) => Effect.Effect<
      { operationId: string; quiesced: true; activeWork: 0; activeVoice: 0; activeDesktops: 0 },
      E | RuntimeAdmissionError,
      R
    >;
    readonly release: (
      operationId: string,
    ) => Effect.Effect<{ operationId: string; released: true }, RuntimeAdmissionError>;
  }
>()("t3/maintenance/RuntimeAdmission") {}

export const make = Effect.gen(function* () {
  const owner = {};
  const state = yield* SubscriptionRef.make<
    AdmissionState & { readonly tokens: ReadonlySet<object> }
  >({
    operationId: null,
    inFlight: 0,
    activeVoice: 0,
    activeDesktops: 0,
    hooks: [],
    tokens: new Set(),
  });
  const maintenance = yield* Semaphore.make(1);

  const reserveCounter = (key: "inFlight" | "activeVoice" | "activeDesktops") =>
    Effect.gen(function* () {
      const lease = yield* Effect.serviceOption(AdmissionLease);
      const token = {};
      const accepted = yield* SubscriptionRef.modify(state, (current) => {
        const inherited =
          Option.isSome(lease) &&
          lease.value.owner === owner &&
          current.tokens.has(lease.value.token);
        if (current.operationId !== null && !inherited) return [false, current] as const;
        const tokens = new Set(current.tokens);
        tokens.add(token);
        return [true, { ...current, [key]: current[key] + 1, tokens }] as const;
      });
      if (!accepted)
        return yield* new RuntimeAdmissionError({
          code: "maintenance_active",
          detail: "Retry after maintenance is released.",
        });
      const release = SubscriptionRef.update(state, (current) => {
        if (!current.tokens.has(token)) return current;
        const tokens = new Set(current.tokens);
        tokens.delete(token);
        return { ...current, [key]: current[key] - 1, tokens };
      });
      return { token, release };
    });

  const reopen = (operationId: string) =>
    SubscriptionRef.update(state, (current) =>
      current.operationId === operationId ? { ...current, operationId: null } : current,
    );

  return RuntimeAdmission.of({
    snapshot: SubscriptionRef.get(state).pipe(
      Effect.map(({ tokens: _tokens, ...snapshot }) => snapshot),
    ),
    awaitOpen: SubscriptionRef.changes(state).pipe(
      Stream.filter((value) => value.operationId === null),
      Stream.take(1),
      Stream.runDrain,
    ),
    registerHook: (name) =>
      SubscriptionRef.update(state, (current) =>
        current.hooks.includes(name) ? current : { ...current, hooks: [...current.hooks, name] },
      ),
    admit: (effect) =>
      Effect.acquireUseRelease(
        reserveCounter("inFlight"),
        ({ token }) => effect.pipe(Effect.provideService(AdmissionLease, { owner, token })),
        ({ release }) => release,
      ),
    reserve: (kind) =>
      Effect.uninterruptible(
        reserveCounter(
          kind === "voice" ? "activeVoice" : kind === "desktop" ? "activeDesktops" : "inFlight",
        ),
      ).pipe(Effect.map(({ release }) => release)),
    quiesce: (operationId, probe) =>
      maintenance.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(state);
            if (current.operationId !== null && current.operationId !== operationId)
              return yield* new RuntimeAdmissionError({
                code: "operation_conflict",
                detail: "Another maintenance operation owns admission.",
              });
            const missing = REQUIRED_HOOKS.filter((name) => !current.hooks.includes(name));
            if (missing.length > 0)
              return yield* new RuntimeAdmissionError({
                code: "hooks_missing",
                detail: `Missing admission hooks: ${missing.join(", ")}.`,
              });
            const result = {
              operationId,
              quiesced: true,
              activeWork: 0,
              activeVoice: 0,
              activeDesktops: 0,
            } as const;
            if (current.operationId === operationId) return result;
            const closedAdmission = yield* SubscriptionRef.modify(state, (value) =>
              value.inFlight > 0 || value.activeVoice > 0 || value.activeDesktops > 0
                ? ([false, value] as const)
                : ([true, { ...value, operationId }] as const),
            );
            if (!closedAdmission)
              return yield* new RuntimeAdmissionError({
                code: "busy",
                detail: "Admitted work or protected resources are still active.",
              });
            return yield* Effect.gen(function* () {
              const activity = yield* probe();
              if (
                ![activity.activeWork, activity.activeVoice, activity.activeDesktops].every(
                  (count) => Number.isFinite(count) && count >= 0,
                )
              )
                return yield* new RuntimeAdmissionError({
                  code: "invalid_probe",
                  detail: "Activity counts must be finite and nonnegative.",
                });
              if (
                activity.activeWork > 0 ||
                activity.activeVoice > 0 ||
                activity.activeDesktops > 0
              )
                return yield* new RuntimeAdmissionError({
                  code: "busy",
                  detail: "Work, voice or a private desktop lease is still active.",
                });
              return result;
            }).pipe(
              restore,
              Effect.onError(() => reopen(operationId)),
            );
          }),
        ),
      ),
    release: (operationId) =>
      maintenance.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current.operationId !== null && current.operationId !== operationId)
            return yield* new RuntimeAdmissionError({
              code: "operation_conflict",
              detail: "Only the current maintenance operation may release admission.",
            });
          yield* reopen(operationId);
          return { operationId, released: true } as const;
        }),
      ),
  });
});

export const layer = Layer.effect(RuntimeAdmission, make);

/** Optional for upstream service fixtures; the installed runtime must register every hook. */
export const admit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.serviceOption(RuntimeAdmission).pipe(
    Effect.flatMap((service) => (Option.isSome(service) ? service.value.admit(effect) : effect)),
  );

export const registerHook = (name: AdmissionHook) =>
  Effect.serviceOption(RuntimeAdmission).pipe(
    Effect.flatMap((service) =>
      Option.isSome(service) ? service.value.registerHook(name) : Effect.void,
    ),
  );

export const reserve = (kind: ResourceKind) =>
  Effect.serviceOption(RuntimeAdmission).pipe(
    Effect.flatMap((service) =>
      Option.isSome(service) ? service.value.reserve(kind) : Effect.succeed(Effect.void),
    ),
  );

/** Completion and cancellation must drain accepted work while new mutations are closed. */
export function requiresAdmission(command: OrchestrationV2ServerCommand): boolean {
  switch (command.type) {
    case "thread.stop":
    case "run.interrupt":
    case "subagent.stop":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "queued-run.cancel":
    case "thread.settle":
    case "thread.auto-settle":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "notification.delivery.accept":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
    case "thread.title.regeneration.complete":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.sync":
    case "thread.pull-request-watch.sync":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "secret_request.record":
      return false;
    default:
      return true;
  }
}
