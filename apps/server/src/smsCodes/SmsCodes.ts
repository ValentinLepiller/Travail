// @effect-diagnostics nodeBuiltinImport:off - Effect Crypto has no constant-time byte comparison.
import * as NodeCrypto from "node:crypto";
import { SmsCode, SmsCodeDeposit, SmsCodeError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Secrets from "../auth/ServerSecretStore.ts";

const TTL = 5 * 60 * 1000;
const decode = Schema.decodeUnknownEffect(SmsCodeDeposit);

export class SmsCodes extends Context.Service<
  SmsCodes,
  {
    readonly authorize: (token: string) => Effect.Effect<void, SmsCodeError>;
    readonly deposit: (input: unknown) => Effect.Effect<void, SmsCodeError>;
    readonly read: (notBefore: number) => Effect.Effect<ReadonlyArray<SmsCode>>;
  }
>()("t3/smsCodes/SmsCodes") {}

const make = Effect.gen(function* () {
  const secrets = yield* Secrets.ServerSecretStore;
  const entries = yield* Ref.make<ReadonlyArray<SmsCode>>([]);
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.updateAndGet(entries, (items) =>
      items.filter((item) => item.expiresAt > now),
    );
  });
  yield* prune.pipe(Effect.andThen(Effect.sleep("10 seconds")), Effect.forever, Effect.forkScoped);

  return SmsCodes.of({
    authorize: Effect.fnUntraced(function* (token) {
      // Re-read so removing or rotating this receive-only secret revokes access immediately.
      const stored = yield* secrets
        .get("sms-ingest-token")
        .pipe(Effect.mapError(() => new SmsCodeError({ code: "unauthorized" })));
      const presented = new TextEncoder().encode(token);
      if (
        Option.isNone(stored) ||
        stored.value.length < 32 ||
        presented.length !== stored.value.length ||
        !NodeCrypto.timingSafeEqual(presented, stored.value)
      ) {
        return yield* new SmsCodeError({ code: "unauthorized" });
      }
    }),
    deposit: Effect.fnUntraced(function* (input) {
      const value = yield* decode(input).pipe(
        Effect.mapError(() => new SmsCodeError({ code: "invalid_input" })),
      );
      const now = yield* Clock.currentTimeMillis;
      if (value.receivedAt > now + 30_000 || value.receivedAt + TTL <= now) {
        return yield* new SmsCodeError({ code: "expired" });
      }
      const item = { ...value, sender: "Okta", expiresAt: value.receivedAt + TTL };
      yield* Ref.update(entries, (items) =>
        [
          ...items.filter(
            (old) =>
              old.expiresAt > now &&
              !(old.code === item.code && old.receivedAt === item.receivedAt),
          ),
          item,
        ]
          .sort((a, b) => a.receivedAt - b.receivedAt)
          .slice(-20),
      );
    }),
    read: Effect.fnUntraced(function* (notBefore) {
      return (yield* prune).filter((item) => item.receivedAt >= notBefore);
    }),
  });
});

export const layer = Layer.effect(SmsCodes, make);
