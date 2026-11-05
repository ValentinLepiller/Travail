import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { HttpRouter } from "effect/http";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as SmsCodes from "./SmsCodes.ts";
import * as SmsHttp from "./http.ts";

const token = "test-only-receive-token-32-characters";
const app = () =>
  HttpRouter.toWebHandler(
    SmsHttp.layer.pipe(
      Layer.provideMerge(SmsCodes.layer),
      Layer.provide(
        Layer.mock(Secrets.ServerSecretStore)({
          get: () => Effect.succeedSome(new TextEncoder().encode(token)),
        }),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const deposit = (authorization: string, body: unknown) =>
  new Request("https://mt.example/api/sms-codes", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it.live(
  "accepts a valid deposit but refuses missing credentials, other senders and oversized bodies",
  () =>
    Effect.gen(function* () {
      const server = app();
      try {
        const body = {
          sender: "Okta",
          code: "123456",
          receivedAt: yield* Clock.currentTimeMillis,
        };
        assert.equal((yield* Effect.promise(() => server.handler(deposit("", body)))).status, 401);
        assert.equal(
          (yield* Effect.promise(() => server.handler(deposit("Bearer wrong", body)))).status,
          401,
        );
        const response = yield* Effect.promise(() =>
          server.handler(deposit(`Bearer ${token}`, body)),
        );
        assert.equal(response.status, 204);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(
          (yield* Effect.promise(() =>
            server.handler(deposit(`Bearer ${token}`, { ...body, sender: "Else" })),
          )).status,
          400,
        );
        assert.equal(
          (yield* Effect.promise(() =>
            server.handler(deposit(`Bearer ${token}`, { ...body, extra: "x".repeat(5000) })),
          )).status,
          400,
        );
        assert.equal(
          (yield* Effect.promise(() =>
            server.handler(
              new Request("https://mt.example/api/sms-codes", {
                headers: { authorization: `Bearer ${token}` },
              }),
            ),
          )).status,
          404,
        );
      } finally {
        yield* Effect.promise(() => server.dispose());
      }
    }),
);
