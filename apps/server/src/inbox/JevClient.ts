import { InboxMessage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { qualificationQuestion } from "./jevQuestion.ts";

export class JevError extends Schema.TaggedError<JevError>()("JevError", {
  reason: Schema.Literals(["configuration", "api", "limit", "format", "network"]),
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
}) {
  override get message() {
    return `Qualification Jev indisponible (${this.reason}).`;
  }
}

export class JevClient extends Context.Service<
  JevClient,
  {
    readonly evaluate: (entry: InboxMessage) => Effect.Effect<unknown, JevError>;
  }
>()("t3/inbox/JevClient") {}

// Keep the principal intact, including author IDs; the context cannot become a new request.
export const jevPayload = (entry: InboxMessage) => ({
  model: "jev-1.14.0",
  state: {
    current_user: {
      name: "Valentin Lepiller",
      email: "valentin.lepiller@galadrim.fr",
      description: "Développeur fullstack à Galadrim.",
    },
    source: entry.source.kind,
    message:
      entry.source.kind === "gmail"
        ? { ...entry.source.message, author: entry.source.message.sender }
        : {
            ...entry.source.message,
            author: { id: entry.source.message.authorId, name: entry.source.message.authorName },
          },
    context: entry.context,
  },
  questions: qualificationQuestion,
});

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const make = Effect.gen(function* () {
  const secrets = yield* Secrets.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const evaluate = Effect.fn("JevClient.evaluate")(
    function* (entry: InboxMessage) {
      const key = yield* secrets
        .get("typesafe-jev-api-key")
        .pipe(Effect.mapError(() => new JevError({ reason: "configuration" })));
      if (Option.isNone(key) || !key.value.length)
        return yield* new JevError({ reason: "configuration" });
      const encoded = yield* encodePayload(jevPayload(entry)).pipe(
        Effect.mapError(() => new JevError({ reason: "format" })),
      );
      // Conservative byte budget below the 32k per-question context; never truncate the principal.
      if (new TextEncoder().encode(encoded).length > 28_000)
        return yield* new JevError({ reason: "limit" });
      const request = HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
        HttpClientRequest.bearerToken(new TextDecoder().decode(key.value).trim()),
        HttpClientRequest.bodyText(encoded, "application/json"),
      );
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError(() => new JevError({ reason: "network" })));
      if (response.status !== 200) {
        const retry = Number(response.headers["retry-after"]);
        return yield* new JevError({
          reason:
            response.status === 401 || response.status === 403
              ? "configuration"
              : response.status === 400 || response.status === 413
                ? "limit"
                : "api",
          ...(Number.isFinite(retry) && retry > 0
            ? { retryAfterSeconds: Math.min(retry, 1800) }
            : {}),
        });
      }
      return yield* response.json.pipe(Effect.mapError(() => new JevError({ reason: "format" })));
    },
    Effect.timeout("45 seconds"),
    Effect.catchTags({ TimeoutError: () => Effect.fail(new JevError({ reason: "network" })) }),
  );
  return JevClient.of({ evaluate });
});
export const layer = Layer.effect(JevClient, make);
