import { expect, it } from "@effect/vitest";
import {
  AuthTerminalOperateScope,
  AuthSettingsWriteScope,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as HttpAdmission from "./HttpAdmission.ts";
import * as RuntimeAdmission from "./RuntimeAdmission.ts";

const idle = () => Effect.succeed({ activeWork: 0, activeVoice: 0, activeDesktops: 0 });
const close = (gate: RuntimeAdmission.RuntimeAdmission["Service"]) =>
  Effect.forEach(RuntimeAdmission.REQUIRED_HOOKS, (hook) => gate.registerHook(hook)).pipe(
    Effect.andThen(gate.quiesce("test-update", idle)),
  );

it.effect(
  "RPC rejects mutations before side effects, preserves cancellation, and keeps authorization",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      let mutations = 0;
      let cancellations = 0;
      const group = RpcGroup.make(
        Rpc.make(WS_METHODS.terminalWrite, { payload: Schema.Unknown, success: Schema.String }),
        Rpc.make(WS_METHODS.terminalClose, { payload: Schema.Unknown, success: Schema.String }),
      ).middleware(RpcScopeAuthorization);
      const handlers = group.toLayer({
        [WS_METHODS.terminalWrite]: () =>
          Effect.sync(() => {
            mutations++;
            return "written";
          }),
        [WS_METHODS.terminalClose]: () =>
          Effect.sync(() => {
            cancellations++;
            return "closed";
          }),
      });
      const makeClient = (authorized: boolean) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              handlers,
              RpcAuthorization.layer(
                authorized ? [AuthTerminalOperateScope] : [AuthSettingsWriteScope],
              ),
            ).pipe(Layer.provide(Layer.succeed(RuntimeAdmission.RuntimeAdmission, gate))),
          ),
        );
      const client = yield* makeClient(true);
      const unauthorized = yield* makeClient(false);
      yield* close(gate);
      expect(yield* client[WS_METHODS.terminalWrite]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "RuntimeAdmissionError",
        code: "maintenance_active",
      });
      expect(yield* client[WS_METHODS.terminalClose]({})).toBe("closed");
      expect(yield* unauthorized[WS_METHODS.terminalClose]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthTerminalOperateScope,
      });
      expect(mutations).toBe(0);
      expect(cancellations).toBe(1);
      yield* gate.release("test-update");
      expect(yield* client[WS_METHODS.terminalWrite]({})).toBe("written");
      expect(mutations).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "HTTP gates launch preparation while reads, authentication and separately guarded transports drain",
  () =>
    Effect.gen(function* () {
      const gate = yield* RuntimeAdmission.make;
      let launched = 0;
      const routes = Layer.mergeAll(
        HttpRouter.add(
          "POST",
          "/api/orchestration/threads/launch",
          Effect.sync(() => {
            launched++;
            return HttpServerResponse.text("launched");
          }),
        ),
        HttpRouter.add("GET", "/snapshot", HttpServerResponse.text("read")),
        HttpRouter.add("POST", "/api/auth/browser-session", HttpServerResponse.text("auth")),
        HttpRouter.add("POST", "/mcp", HttpServerResponse.text("tool transport")),
        HttpAdmission.layer,
      ).pipe(Layer.provideMerge(Layer.succeed(RuntimeAdmission.RuntimeAdmission, gate)));
      const web = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (value) => Effect.promise(() => value.dispose()),
      );
      yield* close(gate);
      const response = yield* Effect.promise(() =>
        web.handler(
          new Request("http://localhost/api/orchestration/threads/launch", { method: "POST" }),
        ),
      );
      expect(response.status).toBe(423);
      expect(launched).toBe(0);
      for (const [method, path] of [
        ["GET", "/snapshot"],
        ["POST", "/api/auth/browser-session"],
        ["POST", "/mcp"],
      ] as const) {
        expect(
          (yield* Effect.promise(() =>
            web.handler(new Request(`http://localhost${path}`, { method })),
          )).status,
        ).toBe(200);
      }
      yield* gate.release("test-update");
      expect(
        (yield* Effect.promise(() =>
          web.handler(
            new Request("http://localhost/api/orchestration/threads/launch", { method: "POST" }),
          ),
        )).status,
      ).toBe(200);
      expect(launched).toBe(1);
    }).pipe(Effect.scoped),
);
