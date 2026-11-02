import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  GmailCollectionPage,
  GmailCollectionInput,
  type GmailTaskRules,
} from "./gmailTaskRules.ts";

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(GmailCollectionInput));
const decodePage = Schema.decodeEffect(Schema.fromJsonString(GmailCollectionPage));

export class GmailCollectionError extends Schema.TaggedError<GmailCollectionError>()(
  "GmailCollectionError",
  {
    stage: Schema.Literals(["configuration", "source", "storage"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `La collecte Gmail a échoué (${this.stage}).`;
  }
}

export class GmailTaskSource extends Context.Service<
  GmailTaskSource,
  {
    readonly readPage: (
      collector: GmailTaskRules["collector"],
      input: GmailCollectionInput,
    ) => Effect.Effect<GmailCollectionPage, GmailCollectionError>;
  }
>()("t3/workTasks/GmailTaskSource") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readPage = Effect.fn("GmailTaskSource.readPage")(function* (
    collector: GmailTaskRules["collector"],
    input: GmailCollectionInput,
  ) {
    return yield* Effect.gen(function* () {
      const inputJson = yield* encodeInput(input);
      const child = yield* spawner.spawn(
        ChildProcess.make(collector.executable, collector.args, {
          cwd: collector.cwd,
          env: { ...process.env, CODEX_HOME: collector.codexHome },
          stdin: { stream: Stream.encodeText(Stream.make(inputJson)) },
          stdout: "pipe",
          stderr: "ignore",
          forceKillAfter: "5 seconds",
        }),
      );
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFoldEffect(
          () => "",
          (text, chunk) =>
            text.length + chunk.length > 3_000_000
              ? Effect.fail(
                  new GmailCollectionError({ stage: "source", cause: "Collector output limit" }),
                )
              : Effect.succeed(text + chunk),
        ),
      );
      if (Number(yield* child.exitCode) !== 0) {
        return yield* new GmailCollectionError({
          stage: "source",
          cause: "Collector exited unsuccessfully",
        });
      }
      return yield* decodePage(output);
    }).pipe(
      Effect.scoped,
      Effect.timeout("120 seconds"),
      Effect.mapError((cause) => new GmailCollectionError({ stage: "source", cause })),
    );
  });
  return GmailTaskSource.of({ readPage });
});
export const layer = Layer.effect(GmailTaskSource, make);
