import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Jev from "./JevClient.ts";

const captureError = Effect.match({
  onSuccess: () => ({ reason: "unexpected_success" }),
  onFailure: (error: Jev.JevError) => error,
});

const entry = {
  id: "test",
  collectedAt: "2026-11-08T12:00:00Z",
  url: "https://example.com",
  source: {
    kind: "gmail" as const,
    message: {
      accountEmail: "me@example.com",
      id: "mail",
      threadId: "thread",
      receivedAt: "1793278000.000001",
      sender: "Other",
      subject: "Subject",
      text: "Valentin, peux-tu corriger le bug ?",
    },
  },
  context: {
    version: 1 as const,
    status: "ready" as const,
    checkedAt: "2026-11-08T12:00:00Z",
    messages: [],
    truncated: false,
    reason: null,
  },
};

it.effect(
  "uses protected app credentials, keeps message/context/user separate and rejects oversized inputs without a call",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const client = yield* Jev.JevClient,
        secrets = yield* Secrets.ServerSecretStore;
      expect((yield* client.evaluate(entry).pipe(captureError)).reason).toBe("configuration");
      yield* secrets.set("typesafe-jev-api-key", new TextEncoder().encode("synthetic-test-key"));
      expect(Jev.jevPayload(entry)).toMatchObject({
        model: "jev-1.14.0",
        state: {
          current_user: {
            name: "Valentin Lepiller",
            description: "Développeur fullstack à Galadrim.",
          },
          message: { text: entry.source.message.text },
          context: { status: "ready", messages: [] },
        },
      });
      yield* client.evaluate(entry);
      expect(
        (yield* client
          .evaluate({
            ...entry,
            source: {
              ...entry.source,
              message: { ...entry.source.message, text: "x".repeat(30_000) },
            },
          })
          .pipe(captureError)).reason,
      ).toBe("limit");
      expect(calls).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Jev.layer.pipe(
          Layer.provideMerge(Secrets.layer),
          Layer.provide(Config.layerTest(process.cwd(), { prefix: "jev-client-" })),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                calls++;
                expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
                expect(request.headers.authorization).toBe("Bearer synthetic-test-key");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, Response.json({ test: true })),
                );
              }),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "surfaces API/configuration/limit errors and bounded retry-after without returning a qualification",
  () => {
    let status = 429;
    return Effect.gen(function* () {
      const client = yield* Jev.JevClient,
        secrets = yield* Secrets.ServerSecretStore;
      yield* secrets.set("typesafe-jev-api-key", new TextEncoder().encode("synthetic-test-key"));
      expect(yield* client.evaluate(entry).pipe(captureError)).toMatchObject({
        reason: "api",
        retryAfterSeconds: 1800,
      });
      status = 401;
      expect((yield* client.evaluate(entry).pipe(captureError)).reason).toBe("configuration");
      status = 400;
      expect((yield* client.evaluate(entry).pipe(captureError)).reason).toBe("limit");
      status = 200;
      expect((yield* client.evaluate(entry).pipe(captureError)).reason).toBe("format");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Jev.layer.pipe(
          Layer.provideMerge(Secrets.layer),
          Layer.provide(Config.layerTest(process.cwd(), { prefix: "jev-http-" })),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("invalid-json", { status, headers: { "retry-after": "9999" } }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  },
);
