import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as SmsCodes from "./SmsCodes.ts";

const token = new TextEncoder().encode("test-only-receive-token-32-characters");

it.effect("expires codes from the original receipt time and filters the requested login", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000_000);
    const codes = yield* SmsCodes.SmsCodes;
    yield* codes.deposit({ sender: "OKTA", code: "123456", receivedAt: 999_000 });
    assert.lengthOf(yield* codes.read(999_000), 1);
    assert.lengthOf(yield* codes.read(1_000_000), 0);
    yield* TestClock.adjust("5 minutes");
    assert.deepStrictEqual(yield* codes.read(1), []);
    assert.equal(
      (yield* codes
        .deposit({ sender: "Okta", code: "123456", receivedAt: 999_000 })
        .pipe(Effect.flip)).code,
      "expired",
    );
  }).pipe(
    Effect.provide(
      SmsCodes.layer.pipe(
        Layer.provide(
          Layer.mock(Secrets.ServerSecretStore)({ get: () => Effect.succeedSome(token) }),
        ),
      ),
    ),
  ),
);

it.effect("rejects wrong senders and malformed or future codes and bounds the inbox", () =>
  Effect.gen(function* () {
    const codes = yield* SmsCodes.SmsCodes;
    const now = (yield* Clock.currentTimeMillis) + 1;
    for (const input of [
      { sender: "Other", code: "123456", receivedAt: now },
      { sender: "Okta", code: "not-a-code", receivedAt: now },
      { sender: "Okta", code: "123456", receivedAt: now + 31_000 },
    ])
      yield* codes.deposit(input).pipe(Effect.flip);
    for (let index = 0; index < 25; index++) {
      yield* codes.deposit({ sender: "Okta", code: String(100000 + index), receivedAt: now });
    }
    yield* codes.deposit({ sender: "okta", code: "100024", receivedAt: now });
    const items = yield* codes.read(1);
    assert.lengthOf(items, 20);
    assert.equal(items[19]?.sender, "Okta");
  }).pipe(
    Effect.provide(
      SmsCodes.layer.pipe(
        Layer.provide(
          Layer.mock(Secrets.ServerSecretStore)({ get: () => Effect.succeedSome(token) }),
        ),
      ),
    ),
  ),
);

it.effect("revokes the deposit credential when removed or rotated", () =>
  Effect.gen(function* () {
    const secret = yield* Ref.make<Option.Option<Uint8Array>>(Option.some(token));
    yield* Effect.gen(function* () {
      const codes = yield* SmsCodes.SmsCodes;
      yield* codes.authorize(new TextDecoder().decode(token));
      yield* codes.authorize("wrong").pipe(Effect.flip);
      yield* Ref.set(secret, Option.none());
      assert.equal(
        (yield* codes.authorize(new TextDecoder().decode(token)).pipe(Effect.flip)).code,
        "unauthorized",
      );
    }).pipe(
      Effect.provide(
        SmsCodes.layer.pipe(
          Layer.provide(Layer.mock(Secrets.ServerSecretStore)({ get: () => Ref.get(secret) })),
        ),
      ),
    );
  }),
);
