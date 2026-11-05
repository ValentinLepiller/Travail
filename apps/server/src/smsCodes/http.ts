import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SmsCodeError } from "@t3tools/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as SmsCodes from "./SmsCodes.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const codes = yield* SmsCodes.SmsCodes;
  yield* codes.authorize(
    request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "",
  );
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    return HttpServerResponse.empty({ status: 415 });
  }
  const text = yield* request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(4096)),
    Effect.mapError(() => new SmsCodeError({ code: "invalid_input" })),
  );
  if (new TextEncoder().encode(text).length > 4096) {
    return HttpServerResponse.empty({ status: 400 });
  }
  const input = yield* decodeJson(text).pipe(
    Effect.mapError(() => new SmsCodeError({ code: "invalid_input" })),
  );
  yield* codes.deposit(input);
  return HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } });
}).pipe(
  Effect.catchTags({
    SmsCodeError: (error) =>
      Effect.succeed(
        HttpServerResponse.empty({ status: error.code === "unauthorized" ? 401 : 400 }),
      ),
  }),
);

export const layer = HttpRouter.add("POST", "/api/sms-codes", handler);
