import { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export const subjectModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
};
export class SubjectModelError extends Schema.TaggedError<SubjectModelError>()(
  "SubjectModelError",
  {
    reason: Schema.Literals(["configuration", "model", "format", "limit"]),
  },
) {}
export class InboxSubjectModel extends Context.Service<
  InboxSubjectModel,
  {
    readonly generate: (prompt: string) => Effect.Effect<string, SubjectModelError>;
  }
>()("t3/inbox/InboxSubjectModel") {}
export const layer = Layer.effect(
  InboxSubjectModel,
  Effect.gen(function* () {
    const registry = yield* Registry.ProviderInstanceRegistry;
    const generation = yield* TextGeneration.TextGeneration;
    const config = yield* Config.ServerConfig;
    return InboxSubjectModel.of({
      generate: Effect.fn("InboxSubjectModel.generate")(function* (prompt) {
        const instance = yield* registry.getInstance(subjectModelSelection.instanceId);
        if (!instance || !instance.enabled || instance.driverKind !== "codex")
          return yield* new SubjectModelError({ reason: "configuration" });
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (
          snapshot.auth.status !== "authenticated" ||
          !snapshot.models.some((m) => m.slug === subjectModelSelection.model)
        )
          return yield* new SubjectModelError({ reason: "configuration" });
        const reply = yield* generation
          .generateChatReply({ cwd: config.cwd, prompt, modelSelection: subjectModelSelection })
          .pipe(Effect.mapError(() => new SubjectModelError({ reason: "model" })));
        return reply.text;
      }),
    });
  }),
);
