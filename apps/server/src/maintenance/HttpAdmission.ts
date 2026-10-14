import { OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as RuntimeAdmission from "./RuntimeAdmission.ts";

const isAdmissionError = Schema.is(RuntimeAdmission.RuntimeAdmissionError);
const decodeCommand = Schema.decodeUnknownOption(OrchestrationV2Command);

/** These transports enforce admission at their typed mutation boundary. */
const separatelyGuarded = (path: string) =>
  path === "/mcp" ||
  path.startsWith("/api/agent-desktops/") ||
  path.startsWith("/api/harness/maintenance/") ||
  path.startsWith("/api/auth/") ||
  path.startsWith("/oauth/");

export const layer = HttpRouter.middleware(
  Effect.gen(function* () {
    const admission = yield* RuntimeAdmission.RuntimeAdmission;
    yield* admission.registerHook("http");
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = request.url.split("?")[0]!;
        if (
          ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
          separatelyGuarded(path) ||
          path === "/api/pull-requests/diff"
        )
          return yield* httpEffect;
        if (path === "/api/orchestration/dispatch") {
          const command = decodeCommand(yield* request.json);
          if (
            Option.isSome(command) &&
            !RuntimeAdmission.requiresAdmission(
              command.value.type === "message.dispatch"
                ? { ...command.value, createdBy: "user" }
                : command.value,
            )
          )
            return yield* httpEffect;
        }
        return yield* admission
          .admit(httpEffect)
          .pipe(
            Effect.catchIf(isAdmissionError, (error) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: error.code, message: error.message },
                  { status: 423 },
                ),
              ),
            ),
          );
      });
  }),
  { global: true },
);
