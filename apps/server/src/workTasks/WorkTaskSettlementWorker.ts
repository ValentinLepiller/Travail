import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Tasks from "./WorkTaskService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const tasks = yield* Tasks.WorkTaskService;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type !== "thread.settled" || event.payload.settledOverride !== "settled")
          return Effect.void;
        return tasks.completeForSettledThread(event.threadId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Completing settled agent tasks failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        );
      }),
    );
  }),
);
