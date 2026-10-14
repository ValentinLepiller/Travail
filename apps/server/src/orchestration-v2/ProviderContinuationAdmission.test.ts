import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as ProviderContinuationAdmission from "./ProviderContinuationAdmission.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const request: ProviderContinuationRequests.ProviderContinuationRequest = {
  threadId: ThreadId.make("thread:continuation-admission"),
  providerThreadId: ProviderThreadId.make("provider-thread:continuation-admission"),
  driver: ProviderDriverKind.make("codex"),
  detail: "Native work completed.",
};
const idle = () => Effect.succeed({ activeWork: 0, activeVoice: 0, activeDesktops: 0 });
const layerRequests = ProviderContinuationAdmission.layerRequests.pipe(
  Layer.provideMerge(RuntimeAdmission.layer),
);
const registerHooks = (gate: RuntimeAdmission.RuntimeAdmission["Service"]) =>
  Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (hook) => gate.registerHook(hook));

it.effect(
  "counts queued continuations through retry and preserves native offers while awaiting release",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.RuntimeAdmission;
      const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const reservations = yield* ProviderContinuationAdmission.ContinuationReservations;
      yield* registerHooks(gate);
      yield* requests.offer(request);
      expect((yield* gate.snapshot).inFlight).toBe(1);
      expect((yield* gate.quiesce("maintenance", idle).pipe(Effect.flip)).code).toBe("busy");
      const accepted = yield* requests.take;
      yield* requests.offer(accepted);
      expect((yield* gate.snapshot).inFlight).toBe(1);
      const retried = yield* requests.take;
      yield* reservations.finish(retried);
      yield* reservations.finish(retried);
      expect((yield* gate.snapshot).inFlight).toBe(0);

      yield* gate.quiesce("maintenance", idle);
      const resumedOffer = yield* requests
        .offer({
          ...request,
          clearIfCurrent: () => Effect.die("Maintenance must preserve the provider buffer"),
          dispatchIfCurrent: () =>
            Effect.die("Refused work must not enter the adapter's sticky-offer guard"),
        })
        .pipe(Effect.forkScoped);
      expect((yield* gate.snapshot).inFlight).toBe(0);
      yield* gate.release("maintenance");
      yield* Fiber.join(resumedOffer);
      const resumed = yield* requests.take;
      yield* reservations.finish(resumed);
      expect((yield* gate.snapshot).inFlight).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layerRequests)),
);

it.effect(
  "keeps a late native source pending until the busy probe reopens and its offer is enqueued",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* registerHooks(gate);
      const sourcePending = yield* Ref.make(false);
      const probeEntered = yield* Deferred.make<void>();
      const recheck = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const requestsLayer = ProviderContinuationAdmission.layerRequests.pipe(
        Layer.provideMerge(
          Layer.succeed(RuntimeAdmission.RuntimeAdmission, {
            ...gate,
            awaitOpen: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(gate.awaitOpen)),
          }),
        ),
      );
      return yield* Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const reservations = yield* ProviderContinuationAdmission.ContinuationReservations;
        const attempt = yield* gate
          .quiesce("maintenance", () =>
            Deferred.succeed(probeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(recheck)),
              Effect.andThen(Ref.get(sourcePending)),
              Effect.map((pending) => ({
                activeWork: pending ? 1 : 0,
                activeVoice: 0,
                activeDesktops: 0,
              })),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(probeEntered);
        yield* Ref.set(sourcePending, true);
        const offered = yield* requests.offer(request).pipe(
          Effect.tap(() => Ref.set(sourcePending, false)),
          Effect.forkScoped,
        );
        yield* Deferred.await(waiting);
        expect(yield* Ref.get(sourcePending)).toBe(true);
        expect((yield* gate.snapshot).inFlight).toBe(0);
        yield* Deferred.succeed(recheck, undefined);
        expect((yield* Fiber.join(attempt).pipe(Effect.flip)).code).toBe("busy");
        yield* Fiber.join(offered);
        expect(yield* Ref.get(sourcePending)).toBe(false);
        expect((yield* gate.snapshot).inFlight).toBe(1);
        yield* reservations.finish(yield* requests.take);
        expect((yield* gate.snapshot).inFlight).toBe(0);
      }).pipe(Effect.provide(requestsLayer));
    }).pipe(Effect.scoped),
);

it.effect(
  "keeps accepted continuation work busy through the real worker and releases it after dispatch",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const consumed = yield* Deferred.make<void>();
      const reservations = yield* ProviderContinuationAdmission.ContinuationReservations;
      const projection = {
        thread: { archivedAt: null, deletedAt: null },
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(projection),
        dispatch: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(complete)),
            Effect.as({} as never),
          ),
      });
      const layerWorker = ProviderContinuationService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            layerThreads,
            Layer.succeed(ProviderContinuationAdmission.ContinuationReservations, {
              finish: (accepted) =>
                reservations
                  .finish(accepted)
                  .pipe(Effect.tap(() => Deferred.succeed(consumed, undefined))),
            }),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const gate = yield* RuntimeAdmission.RuntimeAdmission;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* registerHooks(gate);
        yield* requests.offer(request);
        yield* Deferred.await(entered);
        expect((yield* gate.quiesce("maintenance", idle).pipe(Effect.flip)).code).toBe("busy");
        yield* Deferred.succeed(complete, undefined);
        yield* Deferred.await(consumed);
        expect((yield* gate.snapshot).inFlight).toBe(0);
        yield* gate.quiesce("maintenance", idle);
      }).pipe(Effect.provide(layerWorker));
    }).pipe(Effect.scoped, Effect.provide(layerRequests)),
);
