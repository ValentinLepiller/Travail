import { AuthEnvironmentMaintainScope, TravailUpdateRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as MaintenanceActivity from "./MaintenanceActivity.ts";
import * as TravailUpdates from "./TravailUpdates.ts";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

class MaintenanceRequestError extends Schema.TaggedError<MaintenanceRequestError>()(
  "MaintenanceRequestError",
  {},
) {}
const Request = Schema.Struct({
  version: Schema.Literals([1, 2]),
  operationId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeUpdateRequest = Schema.decodeUnknownEffect(TravailUpdateRequest);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
  const action =
    url.value.pathname === "/api/harness/maintenance/quiesce"
      ? "quiesce"
      : url.value.pathname === "/api/harness/maintenance/release"
        ? "release"
        : undefined;
  const isTravailUpdate = url.value.pathname === "/api/harness/maintenance/travail-update";
  if (!action && !isTravailUpdate) return HttpServerResponse.empty({ status: 404 });
  if (request.method !== "POST" && !(isTravailUpdate && request.method === "GET"))
    return HttpServerResponse.empty({ status: 405 });
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (EnvironmentAuth.isServerAuthCredentialError(error)) {
          return yield* AuthHttp.failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          );
        }
        return yield* AuthHttp.failEnvironmentInternal("internal_error", error);
      }),
    ),
  );
  if (!session.scopes.includes(AuthEnvironmentMaintainScope)) {
    return yield* AuthHttp.failEnvironmentScopeRequired(AuthEnvironmentMaintainScope);
  }
  if (isTravailUpdate) {
    const updates = yield* TravailUpdates.TravailUpdates;
    if (request.method === "GET") {
      const status = yield* updates.status;
      return HttpServerResponse.jsonUnsafe(status, { headers: { "cache-control": "no-store" } });
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      return HttpServerResponse.empty({ status: 415 });
    }
    const { revision } = yield* request.json.pipe(
      Effect.flatMap(decodeUpdateRequest),
      Effect.mapError(() => new MaintenanceRequestError()),
    );
    return HttpServerResponse.empty({ status: (yield* updates.install(revision)) ? 202 : 404 });
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    return HttpServerResponse.empty({ status: 415 });
  }
  // The operation ID is a lease correlation, never an authentication identity.
  const input = yield* request.json.pipe(
    Effect.flatMap(decodeRequest),
    Effect.mapError(() => new MaintenanceRequestError()),
  );
  const admission = yield* RuntimeAdmission.RuntimeAdmission;
  const result =
    action === "release"
      ? yield* admission.release(input.operationId)
      : yield* Effect.gen(function* () {
          const activity = yield* MaintenanceActivity.MaintenanceActivity;
          const restartAgents = input.version === 2;
          return yield* admission.quiesce(
            input.operationId,
            () => (restartAgents ? activity.readForAgentRestart : activity.read),
            restartAgents,
          );
        });
  return HttpServerResponse.jsonUnsafe(
    { version: input.version, ...result },
    { headers: { "cache-control": "no-store" } },
  );
}).pipe(
  Effect.catchTags({
    TravailUpdateError: (error) =>
      Effect.logWarning("Travail update request failed", error.cause).pipe(
        Effect.as(HttpServerResponse.empty({ status: 503 })),
      ),
    MaintenanceRequestError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    RuntimeAdmissionError: (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { code: error.code },
          {
            status:
              error.code === "operation_conflict" || error.code === "maintenance_active"
                ? 423
                : error.code === "busy"
                  ? 409
                  : 503,
          },
        ),
      ),
    MaintenanceActivityError: () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ code: "activity_unavailable" }, { status: 503 }),
      ),
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

export const layer = HttpRouter.add("*", "/api/harness/maintenance/*", handler);
