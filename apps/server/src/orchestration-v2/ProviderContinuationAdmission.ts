import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";

type Request = ProviderContinuationRequests.ProviderContinuationRequest;

export class ContinuationReservations extends Context.Reference<{
  readonly finish: (request: Request) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderContinuationAdmission/ContinuationReservations", {
  defaultValue: () => ({ finish: () => Effect.void }),
}) {}

/** One shared queue tracks accepted requests through consumption and retry backoff. */
export const layerRequests = Layer.unwrap(
  Effect.gen(function* () {
    const admission = yield* Effect.serviceOption(RuntimeAdmission.RuntimeAdmission);
    const queue = yield* Queue.unbounded<Request>();
    const pending = yield* Ref.make<ReadonlyMap<Request, Effect.Effect<void>>>(new Map());
    const finish = (request: Request) =>
      Ref.modify(pending, (current) => {
        const release = current.get(request);
        if (release === undefined) return [Effect.void, current] as const;
        const next = new Map(current);
        next.delete(request);
        return [release, next] as const;
      }).pipe(Effect.flatMap((release) => release));

    const offer = (request: Request) =>
      Effect.uninterruptibleMask((restore) => {
        const reserveWork: Effect.Effect<Effect.Effect<void>> = Effect.suspend(() =>
          Option.isSome(admission) ? admission.value.reserve("work") : Effect.succeed(Effect.void),
        ).pipe(
          Effect.catchTags({
            RuntimeAdmissionError: (error) =>
              error.code === "maintenance_active" && Option.isSome(admission)
                ? restore(admission.value.awaitOpen).pipe(
                    Effect.andThen(Effect.suspend(() => reserveWork)),
                  )
                : Effect.die(error),
          }),
        );
        return Effect.gen(function* () {
          if ((yield* Ref.get(pending)).has(request)) {
            yield* Queue.offer(queue, request);
            return;
          }
          const release = yield* reserveWork;
          const accepted = { ...request };
          yield* Ref.update(pending, (current) => new Map(current).set(accepted, release));
          yield* Queue.offer(queue, accepted);
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Queue.shutdown(queue);
        const remaining = yield* Ref.getAndSet(pending, new Map());
        yield* Effect.forEach(remaining.values(), (release) => release, { discard: true });
      }),
    );
    return Layer.mergeAll(
      Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
        offer,
        take: Queue.take(queue),
      }),
      Layer.succeed(ContinuationReservations, { finish }),
    );
  }),
);
