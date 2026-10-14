import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
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
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

class MaintenanceRequestError extends Schema.TaggedError<MaintenanceRequestError>()(
  "MaintenanceRequestError",
  {},
) {}
const Request = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);

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
  if (!action) return HttpServerResponse.empty({ status: 404 });
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
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
          return yield* admission.quiesce(input.operationId, () => activity.read);
        });
  return HttpServerResponse.jsonUnsafe(
    { version: 1, ...result },
    { headers: { "cache-control": "no-store" } },
  );
}).pipe(
  Effect.catchTags({
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
