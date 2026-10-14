import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as MaintenanceActivity from "./MaintenanceActivity.ts";
import * as MaintenanceHttp from "./MaintenanceHttp.ts";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

const auth = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) => {
    const credential = request.headers.authorization ?? request.headers.cookie;
    if (!credential) return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
    return Effect.succeed({
      sessionId: AuthSessionId.make("maintenance-test"),
      subject: "test",
      method: "bearer-access-token",
      scopes:
        credential === "Bearer read-only"
          ? [AuthOrchestrationReadScope]
          : [AuthEnvironmentMaintainScope],
    });
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);
const request = (
  action: string,
  operationId: string,
  credential = "Bearer maintain",
  extra: object = {},
) =>
  new Request(`http://127.0.0.1/api/harness/maintenance/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credential.startsWith("cookie:")
        ? { cookie: credential.slice(7) }
        : credential
          ? { authorization: credential }
          : {}),
    },
    body: JSON.stringify({ version: 1, operationId, ...extra }),
  });
const fixture = (
  gate: RuntimeAdmission.RuntimeAdmission["Service"],
  read = Effect.succeed<RuntimeAdmission.Activity>({
    activeWork: 0,
    activeVoice: 0,
    activeDesktops: 0,
  }),
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        MaintenanceHttp.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(RuntimeAdmission.RuntimeAdmission, gate),
              Layer.succeed(MaintenanceActivity.MaintenanceActivity, { read }),
              auth,
            ),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

it.effect("requires authenticated maintenance scope rather than trusting a JSON owner", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    const web = yield* fixture(gate);
    expect(
      (yield* Effect.promise(() => web.handler(request("quiesce", "op", "", { owner: "admin" }))))
        .status,
    ).toBe(401);
    expect(
      (yield* Effect.promise(() =>
        web.handler(request("quiesce", "op", "Bearer read-only", { owner: "admin" })),
      )).status,
    ).toBe(403);
    expect((yield* gate.snapshot).operationId).toBeNull();
  }),
);

it.effect(
  "delegates bearer, DPoP and cookie authentication and releases only the matching operation",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
      const web = yield* fixture(gate);
      for (const credential of [
        "Bearer maintain",
        "DPoP proof-bound-fixture",
        "cookie:fixture=maintain",
      ]) {
        const response = yield* Effect.promise(() =>
          web.handler(request("quiesce", "op-1", credential)),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          version: 1,
          operationId: "op-1",
          quiesced: true,
          activeWork: 0,
          activeVoice: 0,
          activeDesktops: 0,
        });
        expect(
          (yield* Effect.promise(() => web.handler(request("release", "foreign", credential))))
            .status,
        ).toBe(423);
        expect(
          (yield* Effect.promise(() => web.handler(request("release", "op-1", credential)))).status,
        ).toBe(200);
        expect(
          (yield* Effect.promise(() => web.handler(request("release", "op-1", credential)))).status,
        ).toBe(200);
      }
    }),
);

it.effect("fails closed for missing hooks, busy work and malformed requests", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    const web = yield* fixture(
      gate,
      Effect.succeed({ activeWork: 1, activeVoice: 0, activeDesktops: 0 }),
    );
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "op")))).status).toBe(503);
    yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "op")))).status).toBe(409);
    expect((yield* gate.snapshot).operationId).toBeNull();
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "bad id")))).status).toBe(
      400,
    );
    expect(
      (yield* Effect.promise(() =>
        web.handler(request("quiesce", "op", "Bearer maintain", { version: 2 })),
      )).status,
    ).toBe(400);
  }),
);

it.effect("does not close an active voice call to make maintenance succeed", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
    const releaseCall = yield* gate.reserve("voice");
    const web = yield* fixture(gate);
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "op")))).status).toBe(409);
    expect((yield* gate.snapshot).activeVoice).toBe(1);
    expect((yield* gate.snapshot).operationId).toBeNull();
    yield* releaseCall;
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "op")))).status).toBe(200);
  }),
);
