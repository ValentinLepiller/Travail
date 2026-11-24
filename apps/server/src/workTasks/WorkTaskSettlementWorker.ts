import type { ThreadId, ModelSelection, WorkTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Requests from "../agentRequests/AgentRequestService.ts";
import * as Schedule from "effect/Schedule";
import * as Coordinator from "./WorkChantierCoordinator.ts";
import * as Tasks from "./WorkTaskService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventSink.EventSinkV2;
    const tasks = yield* Tasks.WorkTaskService;
    yield* forkParked(
      Effect.gen(function* () {
        const afterSequence = yield* events.latestSequence();
        yield* tasks.recoverSettledTasks();
        yield* Stream.runForEach(
          events.stream({ afterSequence, eventType: "thread.settled" }),
          ({ event }) => {
            if (event.type !== "thread.settled" || event.payload.settledOverride !== "settled")
              return Effect.void;
            return tasks.completeForSettledThread(event.threadId).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Completing settled agent tasks failed", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
              Effect.retry(Schedule.spaced("5 seconds")),
            );
          },
        );
      }).pipe(
        Effect.tapError((cause) => Effect.logWarning("Settlement subscription failed", { cause })),
        Effect.retry(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);

export const dispatchLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tasks = yield* Tasks.WorkTaskService;
    const coordinator = yield* Coordinator.WorkChantierCoordinator;
    const requests = yield* Requests.AgentRequestService;
    const events = yield* EventSink.EventSinkV2;
    const scope = yield* Effect.scope;
    const retrying = new Set<string>();
    const transient = (error: WorkTaskError) =>
      error.reason === "agent" || error.reason === "storage";
    const dispatch = Effect.fn(function* (id: string, model: ModelSelection) {
      yield* coordinator.dispatchReady(id, model).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Dispatching chantier tasks failed", {
              chantierId: id,
              cause,
            });
            if (!transient(cause) || retrying.has(id)) return;
            retrying.add(id);
            const retry = Effect.gen(function* () {
              const chantier = yield* tasks.readChantier(id);
              const selected = chantier.v2?.dispatchModelSelection;
              if (chantier.status === "active" && selected)
                yield* coordinator.dispatchReady(id, selected);
            });
            yield* retry.pipe(
              Effect.retry({ schedule: Schedule.spaced("30 seconds"), while: transient }),
              Effect.delay("5 seconds"),
              Effect.ensuring(Effect.sync(() => retrying.delete(id))),
              Effect.forkIn(scope),
            );
          }),
        ),
      );
    });
    const run = Effect.gen(function* () {
      const afterSequence = yield* events.latestSequence();
      const runChanges = events.stream({ afterSequence, eventType: "run.updated" }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            !["preparing", "queued", "starting", "running"].includes(event.payload.status),
        ),
        Stream.map(({ event }) => event.threadId),
      );
      const watchChanges = events
        .stream({ afterSequence, eventType: "thread.pull-request-synced" })
        .pipe(Stream.map(({ event }) => event.threadId));
      // Only global revision signals supersede one another. Thread events may release slots in different projects.
      const globalChanges = Stream.merge(tasks.changes, requests.changes).pipe(
        Stream.map((): ThreadId | undefined => undefined),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
      );
      yield* Stream.mergeAll([globalChanges, runChanges, watchChanges], { concurrency: 3 }).pipe(
        Stream.runForEach((threadId) =>
          Effect.gen(function* () {
            const targets = yield* tasks.dispatchTargets(threadId);
            yield* Effect.forEach(targets, ({ id, model }) => dispatch(id, model), {
              concurrency: "unbounded",
              discard: true,
            });
          }),
        ),
      );
    });
    yield* forkParked(
      run.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Chantier dispatch subscription failed", { cause }),
        ),
        Effect.retry(Schedule.spaced("5 seconds")),
      ),
    );
  }),
);
