import { AuthTerminalReadScope, AuthTerminalOperateScope, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as AgentDesktops from "./AgentDesktops.ts";
import { AgentDesktopHumanAction } from "@t3tools/contracts";

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeHumanAction = Schema.decodeUnknownEffect(AgentDesktopHumanAction);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
  const route = /^\/api\/agent-desktops\/([^/]{1,256})(?:\/([0-9a-f-]{36}))?$/i.exec(
    url.value.pathname,
  );
  if (!route) return HttpServerResponse.empty({ status: 404 });
  if (!["GET", "POST"].includes(request.method)) return HttpServerResponse.empty({ status: 405 });
  const namespace = yield* Effect.try({
    try: () => decodeURIComponent(route[1]!),
    catch: () => new InvalidHumanAction(),
  }).pipe(
    Effect.flatMap(decodeThreadId),
    Effect.mapError(() => new InvalidHumanAction()),
  );
  if (!namespace.trim() || namespace.includes("/"))
    return HttpServerResponse.empty({ status: 400 });
  const readOnly = request.method === "GET";
  // Reuses MT's cookie/ticket authentication and existing Computer View permission scopes.
  yield* authenticateMediaRequest(readOnly ? AuthTerminalReadScope : AuthTerminalOperateScope);
  const desktops = yield* AgentDesktops.AgentDesktops;
  if (!route[2])
    return readOnly
      ? HttpServerResponse.jsonUnsafe(yield* desktops.list(namespace), {
          headers: { "cache-control": "no-store" },
        })
      : HttpServerResponse.empty({ status: 405 });
  const ownerId = `${namespace}/${route[2]}`;
  if (readOnly) {
    const result =
      url.value.searchParams.get("capture") === "1"
        ? yield* desktops.capture(ownerId)
        : yield* desktops.status(ownerId);
    return HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } });
  }
  if (!request.headers["content-type"]?.startsWith("application/json"))
    return HttpServerResponse.empty({ status: 415 });
  const action = yield* request.json.pipe(
    Effect.flatMap(decodeHumanAction),
    Effect.mapError(() => new InvalidHumanAction()),
  );
  switch (action.action) {
    case "take":
      return HttpServerResponse.jsonUnsafe(
        yield* desktops.transfer(ownerId, action.target, "human"),
      );
    case "release":
      return HttpServerResponse.jsonUnsafe(
        yield* desktops.transfer(ownerId, action.target, "agent"),
      );
    case "input":
      return HttpServerResponse.jsonUnsafe(yield* desktops.input(ownerId, "human", action.input));
    case "close": {
      yield* desktops.close(ownerId, "human", action.target);
      return HttpServerResponse.empty({ status: 204 });
    }
  }
}).pipe(
  Effect.catchTags({
    AgentDesktopError: (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: error.code, message: error.message },
          {
            status:
              error.code === "maintenance_active"
                ? 423
                : error.code === "control_conflict"
                  ? 409
                  : error.code === "not_found"
                    ? 404
                    : error.code === "invalid_input"
                      ? 400
                      : 503,
          },
        ),
      ),
    InvalidHumanAction: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

class InvalidHumanAction extends Schema.TaggedError<InvalidHumanAction>()(
  "InvalidHumanAction",
  {},
) {}

export const layer = HttpRouter.add("*", "/api/agent-desktops/*", handler);
