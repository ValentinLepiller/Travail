import {
  AuthSessionId,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AgentDesktopHttp from "./AgentDesktopHttp.ts";
import * as AgentDesktops from "./AgentDesktops.ts";
import { AgentDesktopError } from "@t3tools/contracts";

const path =
  "https://mt.example/api/agent-desktops/mcp%3A39ad607e-test/00000000-0000-4000-8000-000000000001";
const target = { sessionId: "session", revision: 0 };
const make = (scopes?: readonly AuthEnvironmentScope[]) =>
  HttpRouter.toWebHandler(
    AgentDesktopHttp.layer.pipe(
      Layer.provideMerge([
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWebSocketUpgrade: () =>
            scopes === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  method: "bearer-access-token",
                  subject: "test",
                  scopes,
                }),
        }),
        Layer.mock(AgentDesktops.AgentDesktops)({
          list: () => Effect.succeed([]),
          status: (ownerId) =>
            Effect.succeed({
              ...target,
              ownerId,
              display: ":test",
              width: 1280,
              height: 800,
              applications: 0,
              controller: "agent",
            }),
          transfer: () =>
            Effect.fail(
              new AgentDesktopError({
                code: "control_conflict",
                operation: "transfer",
                cause: new Error("private-cause-must-not-leak"),
              }),
            ),
        }),
        NodeServices.layer,
      ]),
    ),
    { disableLogger: true },
  );

const post = (body: unknown) =>
  new Request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Agent desktop human HTTP adapter", () => {
  it("denies unauthenticated viewers and mutations", async () => {
    const app = make();
    try {
      assert.equal((await app.handler(new Request(path))).status, 401);
      assert.equal((await app.handler(post({ action: "take", target }))).status, 401);
    } finally {
      await app.dispose();
    }
  });
  it("lets a reader inspect but refuses takeover", async () => {
    const app = make([AuthTerminalReadScope]);
    try {
      const response = await app.handler(new Request(path));
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { ownerId: string }).ownerId,
        "mcp:39ad607e-test/00000000-0000-4000-8000-000000000001",
      );
      assert.equal(
        (
          await app.handler(
            new Request("https://mt.example/api/agent-desktops/mcp%3A..%2Fpersonal"),
          )
        ).status,
        400,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(
        (
          await app.handler(
            new Request("https://mt.example/api/agent-desktops/mcp%3A39ad607e-test"),
          )
        ).status,
        200,
      );
      assert.equal((await app.handler(post({ action: "take", target }))).status, 403);
    } finally {
      await app.dispose();
    }
  });
  it("reports stale control as conflict without exposing internal cause", async () => {
    const app = make([AuthTerminalOperateScope]);
    try {
      const response = await app.handler(post({ action: "take", target }));
      assert.equal(response.status, 409);
      assert.equal((await response.text()).includes("private-cause"), false);
      assert.equal(
        (await app.handler(post({ action: "input", input: { kind: "arbitrary-shell-command" } })))
          .status,
        400,
      );
    } finally {
      await app.dispose();
    }
  });
});
