import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  SlackCollectionPage,
  SlackCollectionInput,
  type SlackTaskRules,
} from "./slackTaskRules.ts";

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(SlackCollectionInput));
const decodePage = Schema.decodeEffect(Schema.fromJsonString(SlackCollectionPage));

export class SlackCollectionError extends Schema.TaggedError<SlackCollectionError>()(
  "SlackCollectionError",
  {
    stage: Schema.Literals(["configuration", "source", "storage"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `La collecte Slack a échoué (${this.stage}).`;
  }
}

export class SlackTaskSource extends Context.Service<
  SlackTaskSource,
  {
    readonly readPage: (
      collector: SlackTaskRules["collector"],
      input: SlackCollectionInput,
    ) => Effect.Effect<SlackCollectionPage, SlackCollectionError>;
  }
>()("t3/workTasks/SlackTaskSource") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readPage = Effect.fn("SlackTaskSource.readPage")(function* (
    collector: SlackTaskRules["collector"],
    input: SlackCollectionInput,
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
                  new SlackCollectionError({ stage: "source", cause: "Collector output limit" }),
                )
              : Effect.succeed(text + chunk),
        ),
      );
      if (Number(yield* child.exitCode) !== 0) {
        return yield* new SlackCollectionError({
          stage: "source",
          cause: "Collector exited unsuccessfully",
        });
      }
      return yield* decodePage(output);
    }).pipe(
      Effect.scoped,
      Effect.timeout("120 seconds"),
      Effect.mapError((cause) => new SlackCollectionError({ stage: "source", cause })),
    );
  });
  return SlackTaskSource.of({ readPage });
});
export const layer = Layer.effect(SlackTaskSource, make);
