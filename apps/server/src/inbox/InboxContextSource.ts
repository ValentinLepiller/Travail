import { InboxContextReadInput } from "./contextSourcePages.ts";
import { InboxContextResult, InboxSource } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { GmailTaskRules } from "../workTasks/gmailTaskRules.ts";
import { SlackTaskRules } from "../workTasks/slackTaskRules.ts";

export class InboxContextSourceError extends Schema.TaggedError<InboxContextSourceError>()(
  "InboxContextSourceError",
  {
    reason: Schema.Literals(["configuration", "source", "format"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Contexte indisponible (${this.reason}).`;
  }
}
export class InboxContextSource extends Context.Service<
  InboxContextSource,
  {
    readonly read: (
      source: typeof InboxSource.Type,
    ) => Effect.Effect<InboxContextResult, InboxContextSourceError>;
  }
>()("t3/inbox/InboxContextSource") {}
const gmailRules = Schema.decodeEffect(Schema.fromJsonString(GmailTaskRules));
const slackRules = Schema.decodeEffect(Schema.fromJsonString(SlackTaskRules));
const isSourceError = Schema.is(InboxContextSourceError);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(InboxContextReadInput));
const decode = Schema.decodeEffect(Schema.fromJsonString(InboxContextResult));
const script = new URL(
  import.meta.url.endsWith(".ts")
    ? "./collect-inbox-context.ts"
    : "./inbox/collect-inbox-context.mjs",
  import.meta.url,
);
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const scriptPath = yield* path.fromFileUrl(script);
  const read = Effect.fn("InboxContextSource.read")(function* (source: typeof InboxSource.Type) {
    const collector = yield* Effect.gen(function* () {
      if (source.kind === "gmail") {
        const rules = yield* gmailRules(
          yield* fs.readFileString(path.join(config.stateDir, "gmail-task-rules.json")),
        );
        if (rules.accountEmail !== source.message.accountEmail)
          return yield* new InboxContextSourceError({
            reason: "configuration",
            cause: "Account mismatch",
          });
        return rules.collector;
      }
      const rules = yield* slackRules(
        yield* fs.readFileString(path.join(config.stateDir, "slack-task-rules.json")),
      );
      if (rules.workspaceId !== source.message.workspaceId)
        return yield* new InboxContextSourceError({
          reason: "configuration",
          cause: "Workspace mismatch",
        });
      return rules.collector;
    }).pipe(
      Effect.mapError((cause) =>
        isSourceError(cause)
          ? cause
          : new InboxContextSourceError({ reason: "configuration", cause }),
      ),
    );
    const output = yield* runner
      .run({
        command: collector.executable,
        args: [scriptPath],
        cwd: collector.cwd,
        env: { ...process.env, CODEX_HOME: collector.codexHome },
        stdin: yield* encodeInput({
          source,
          ...(collector.linkId ? { linkId: collector.linkId } : {}),
        }).pipe(
          Effect.mapError((cause) => new InboxContextSourceError({ reason: "format", cause })),
        ),
        timeout: "60 seconds",
        maxOutputBytes: 100_000,
      })
      .pipe(Effect.mapError((cause) => new InboxContextSourceError({ reason: "source", cause })));
    if (
      output.code === null ||
      Number(output.code) !== 0 ||
      output.timedOut ||
      output.stdoutTruncated ||
      output.stdoutInvalidUtf8
    )
      return yield* new InboxContextSourceError({
        reason: "source",
        cause: "Context process failed",
      });
    return yield* decode(output.stdout).pipe(
      Effect.mapError((cause) => new InboxContextSourceError({ reason: "format", cause })),
    );
  });
  return InboxContextSource.of({ read });
});
export const layer = Layer.effect(InboxContextSource, make);
