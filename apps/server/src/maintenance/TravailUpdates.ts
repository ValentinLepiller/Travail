import { TravailUpdateStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(TravailUpdateStatus));

export class TravailUpdateError extends Schema.TaggedError<TravailUpdateError>()(
  "TravailUpdateError",
  { cause: Schema.Defect() },
) {}

export class TravailUpdates extends Context.Service<
  TravailUpdates,
  {
    readonly status: Effect.Effect<TravailUpdateStatus | null, TravailUpdateError>;
    readonly install: (revision: string) => Effect.Effect<boolean, TravailUpdateError>;
  }
>()("t3/maintenance/TravailUpdates") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const operations = path.resolve(config.baseDir, "../harness-operations");
  const controller = path.join(operations, "current/scripts/harness-runtime.ts");
  const enabled = fs.exists(path.join(operations, "current/.t3/travail-revision"));
  const run = (mode: string, argument: string) =>
    processRunner
      .run({
        command: "node",
        args: [controller, mode, argument],
        cwd: config.cwd,
        env: { HARNESS_OPERATIONS: operations },
        timeout: "20 seconds",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(new TravailUpdateError({ cause: result.stderr })),
        ),
      );

  const status = yield* Effect.cachedWithTTL(
    enabled.pipe(
      Effect.flatMap((available) =>
        available
          ? run("travail-status", config.baseDir).pipe(Effect.flatMap(decodeStatus))
          : Effect.succeed(null),
      ),
      Effect.mapError((cause) => new TravailUpdateError({ cause })),
    ),
    "4 seconds",
  );
  return TravailUpdates.of({
    status,
    install: (revision) =>
      enabled.pipe(
        Effect.flatMap((available) =>
          available ? run("travail-queue", revision).pipe(Effect.as(true)) : Effect.succeed(false),
        ),
        Effect.mapError((cause) => new TravailUpdateError({ cause })),
      ),
  });
});

export const layer = Layer.effect(TravailUpdates, make).pipe(Layer.provide(ProcessRunner.layer));
