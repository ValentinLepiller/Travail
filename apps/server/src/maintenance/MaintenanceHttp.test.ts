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
import * as TravailUpdates from "./TravailUpdates.ts";

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
  updates: TravailUpdates.TravailUpdates["Service"] = {
    status: Effect.succeed(null),
    install: () => Effect.succeed(false),
  },
  readForAgentRestart = read,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        MaintenanceHttp.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(RuntimeAdmission.RuntimeAdmission, gate),
              Layer.succeed(MaintenanceActivity.MaintenanceActivity, { read, readForAgentRestart }),
              auth,
              Layer.succeed(TravailUpdates.TravailUpdates, updates),
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
        web.handler(request("quiesce", "op", "Bearer maintain", { version: 3 })),
      )).status,
    ).toBe(400);
  }),
);

it.effect("an explicit agent restart admits the update while agents are running", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
    const web = yield* fixture(
      gate,
      Effect.succeed({ activeWork: 4, activeVoice: 0, activeDesktops: 0 }),
      undefined,
      Effect.succeed({ activeWork: 0, activeVoice: 0, activeDesktops: 0 }),
    );
    const quiesce = (version: number) =>
      Effect.promise(() =>
        web.handler(request("quiesce", "update", "Bearer maintain", { version })),
      );
    const endWork = yield* gate.reserve("work");
    expect((yield* quiesce(1)).status).toBe(409);
    const prepared = yield* quiesce(2);
    yield* endWork;
    expect(prepared.status).toBe(200);
    expect(yield* Effect.promise(() => prepared.json())).toMatchObject({
      version: 2,
      quiesced: true,
    });
    expect((yield* gate.admit(Effect.void).pipe(Effect.flip)).code).toBe("maintenance_active");
  }),
);

it.effect("does not close an active voice call to make maintenance succeed", () =>
  Effect.gen(function* () {
    const gate = yield* RuntimeAdmission.make;
    yield* Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (name) => gate.registerHook(name));
    const releaseCall = yield* gate.reserve("voice");
    const web = yield* fixture(gate);
    expect(
      (yield* Effect.promise(() =>
        web.handler(request("quiesce", "op", "Bearer maintain", { version: 2 })),
      )).status,
    ).toBe(409);
    expect((yield* gate.snapshot).activeVoice).toBe(1);
    expect((yield* gate.snapshot).operationId).toBeNull();
    yield* releaseCall;
    expect((yield* Effect.promise(() => web.handler(request("quiesce", "op")))).status).toBe(200);
  }),
);

it.effect("only a maintenance session can request installation of a valid Travail revision", () =>
  Effect.gen(function* () {
    const revision = "a".repeat(40);
    const requested: string[] = [];
    const status = {
      installed: "b".repeat(40),
      available: revision,
      installing: false,
      failed: false,
    };
    const gate = yield* RuntimeAdmission.make;
    const web = yield* fixture(gate, undefined, {
      status: Effect.succeed(status),
      install: (value) =>
        Effect.sync(() => {
          requested.push(value);
          return true;
        }),
    });
    const url = "http://localhost/api/harness/maintenance/travail-update";
    const current = yield* Effect.promise(() =>
      web.handler(
        new Request(url, {
          headers: { authorization: "Bearer maintain" },
        }),
      ),
    );
    expect(current.status).toBe(200);
    expect(yield* Effect.promise(() => current.json())).toEqual(status);

    for (const [credential, value, expected] of [
      ["Bearer read-only", revision, 403],
      ["Bearer maintain", "main", 400],
      ["Bearer maintain", revision, 202],
    ] as const) {
      const response = yield* Effect.promise(() =>
        web.handler(request("travail-update", "", credential, { revision: value })),
      );
      expect(response.status).toBe(expected);
    }
    expect(requested).toEqual([revision]);
  }).pipe(Effect.scoped),
);
