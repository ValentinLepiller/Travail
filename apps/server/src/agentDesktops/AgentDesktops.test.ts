// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the native X11/filesystem boundary.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentDesktops from "./AgentDesktops.ts";
import { AgentDesktopRuntime } from "./AgentDesktopRuntime.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const integration = process.env.T3_TEST_AGENT_DESKTOPS === "1";

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-desktops-test-"))),
  (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
);

async function desktopEnvironment(directory: string, ownerId: string): Promise<NodeJS.ProcessEnv> {
  const profile = NodePath.join(
    directory,
    NodeCrypto.createHash("sha256").update(ownerId).digest("hex"),
  );
  const info: { busPid: number; busAddress: string } = JSON.parse(
    await NodeFSP.readFile(NodePath.join(profile, "session.json"), "utf8"),
  );
  const fields = (await NodeFSP.readFile(`/proc/${info.busPid}/environ`, "utf8"))
    .split("\0")
    .filter(Boolean);
  return {
    ...Object.fromEntries(
      fields.map((field) => {
        const separator = field.indexOf("=");
        return [field.slice(0, separator), field.slice(separator + 1)];
      }),
    ),
    DBUS_SESSION_BUS_ADDRESS: info.busAddress,
  };
}

describe("AgentDesktops", () => {
  it.effect("refuses absent sessions without ever acquiring a desktop", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      yield* Effect.gen(function* () {
        const desktops = yield* AgentDesktops.AgentDesktops;
        assert.equal((yield* Effect.flip(desktops.status("absent"))).code, "not_found");
        assert.equal((yield* Effect.flip(desktops.ensure(" "))).code, "invalid_input");
        assert.equal(
          (yield* Effect.flip(desktops.acquire("thread", "not-a-lease"))).code,
          "invalid_input",
        );
      }).pipe(Effect.provide(AgentDesktops.layer({ rootDirectory: directory })));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unsafe session/resource configuration before spawning", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        AgentDesktops.AgentDesktops.pipe(
          Effect.provide(AgentDesktops.layer({ rootDirectory: "relative", width: 10000 })),
        ),
      );
      assert.equal(result.code, "unavailable");
    }).pipe(Effect.scoped),
  );
});

describe.skipIf(!integration)("AgentDesktops real X11 boundary", () => {
  it.effect(
    "isolates two leases of the SAME native MCP caller and enforces ownership/control/restart",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        yield* Effect.gen(function* () {
          const desktops = yield* AgentDesktops.AgentDesktops;
          const [a, b] = yield* Effect.all(
            [desktops.acquire("thread"), desktops.acquire("thread")],
            { concurrency: "unbounded" },
          );
          assert.equal((yield* desktops.list("thread")).length, 2);
          assert.equal((yield* desktops.list("other-thread")).length, 0);
          const ownerA = `thread/${a.leaseId}`;
          const ownerB = `thread/${b.leaseId}`;
          assert.notEqual(a.leaseId, b.leaseId);
          assert.notEqual(a.status.display, b.status.display);
          assert.notEqual(a.status.display, process.env.DISPLAY);
          assert.notEqual(b.status.display, process.env.DISPLAY);
          const [envA, envB] = yield* Effect.promise(() =>
            Promise.all([
              desktopEnvironment(directory, ownerA),
              desktopEnvironment(directory, ownerB),
            ]),
          );
          for (const key of [
            "HOME",
            "DISPLAY",
            "XAUTHORITY",
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
          ])
            assert.notEqual(
              (envA as NodeJS.ProcessEnv)[key],
              (envB as NodeJS.ProcessEnv)[key],
              key,
            );
          for (const key of ["WAYLAND_DISPLAY", "SESSION_MANAGER", "AT_SPI_BUS_ADDRESS"])
            assert.equal((envA as NodeJS.ProcessEnv)[key], undefined, key);
          yield* Effect.promise(() =>
            NodeAssert.rejects(
              execute("xdpyinfo", [], { env: { ...envA, XAUTHORITY: envB.XAUTHORITY } }),
            ),
          );
          const cap = yield* Effect.flip(desktops.acquire("other-thread"));
          assert.equal(cap.code, "capacity");
          assert.equal(
            (yield* Effect.flip(desktops.status(`other-thread/${a.leaseId}`))).code,
            "not_found",
          );
          yield* desktops.launch(ownerA, "message", a.status, "Session A privée");
          yield* desktops.launch(ownerB, "message", b.status, "Session B privée");
          const [captureA, captureB] = yield* Effect.all(
            [desktops.capture(ownerA), desktops.capture(ownerB)],
            { concurrency: "unbounded" },
          );
          assert.equal(captureA.windows.length, 1);
          assert.equal(captureB.windows.length, 1);
          assert.notEqual(captureA.windows[0]!.title, captureB.windows[0]!.title);
          assert.equal(captureA.screenshot.data.startsWith("iVBOR"), true);
          assert.equal(
            (yield* Effect.flip(desktops.launch(ownerA, "message", a.status))).code,
            "capacity",
          );
          assert.equal(
            (yield* Effect.flip(
              desktops.input(ownerA, "agent", {
                ...a.status,
                windowId: "0",
                kind: "key",
                key: "Return",
              }),
            )).code,
            "invalid_input",
          );
          const human = yield* desktops.transfer(ownerA, a.status, "human");
          assert.equal(
            (yield* Effect.flip(desktops.launch(ownerA, "message", a.status))).code,
            "control_conflict",
          );
          assert.equal((yield* Effect.flip(desktops.close(ownerA))).code, "control_conflict");
          assert.equal(
            (yield* Effect.flip(
              desktops.input(ownerA, "agent", {
                ...human,
                windowId: captureA.windows[0]!.id,
                kind: "key",
                key: "Return",
              }),
            )).code,
            "control_conflict",
          );
          assert.equal(
            (yield* Effect.flip(desktops.transfer(ownerA, a.status, "agent"))).code,
            "control_conflict",
          );
          const returned = yield* desktops.transfer(ownerA, human, "agent");
          const marker = NodePath.join(envA.HOME!, "persisted-profile");
          yield* Effect.promise(() => NodeFSP.writeFile(marker, "preserved"));
          yield* desktops.close(ownerA, "agent", returned);
          const resumed = yield* desktops.acquire("thread", a.leaseId);
          assert.notEqual(resumed.status.sessionId, a.status.sessionId);
          assert.equal(yield* Effect.promise(() => NodeFSP.readFile(marker, "utf8")), "preserved");
          assert.equal(
            (yield* Effect.flip(desktops.launch(ownerA, "message", a.status))).code,
            "control_conflict",
          );
          assert.equal((yield* desktops.status(ownerB)).sessionId, b.status.sessionId);
        }).pipe(
          Effect.provide(
            AgentDesktops.layer({ rootDirectory: directory, maxSessions: 2, maxApplications: 1 }),
          ),
        );
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it("cleans an idle session after a filesystem lifecycle milestone", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-desktops-idle-"));
    const runtime = new AgentDesktopRuntime({ rootDirectory: directory, idleTimeoutMs: 500 });
    try {
      const human = await runtime.ensure("human");
      await runtime.transfer("human", human, "human");
      await runtime.ensure("idle");
      const env = await desktopEnvironment(directory, "idle");
      const events = NodeFSP.watch(env.XDG_RUNTIME_DIR!);
      const closed = (async () => {
        for await (const event of events) {
          if (event.eventType === "rename" && event.filename === "Xauthority") break;
        }
      })();
      await closed;
      assert.equal((await runtime.status("human")).controller, "human");
      await NodeAssert.rejects(
        runtime.status("idle"),
        (error: { code?: string }) => error.code === "not_found",
      );
      assert.equal(runtime.activeCount(), 1);
    } finally {
      await runtime.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
  it("stops the captured X server when its owning server process dies", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-desktops-death-"));
    const modulePath = new URL("./AgentDesktopRuntime.ts", import.meta.url).href;
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {AgentDesktopRuntime} from ${JSON.stringify(modulePath)}; const root=${JSON.stringify(directory)}; const r=new AgentDesktopRuntime({rootDirectory:root}); const s=await r.ensure('death'); console.log(JSON.stringify(s)); process.stdin.resume();`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      const ready = await new Promise<string>((resolve, reject) => {
        child.stdout!.once("data", (data: Buffer) => resolve(data.toString()));
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Fixture exited before ready")));
      });
      const session: { display: string } = JSON.parse(ready);
      const socketName = `X${session.display.slice(1)}`;
      const events = NodeFSP.watch("/tmp/.X11-unix");
      const removed = (async () => {
        for await (const event of events) {
          if (event.eventType === "rename" && event.filename === socketName) break;
        }
      })();
      child.kill("SIGKILL");
      await removed;
      await NodeAssert.rejects(NodeFSP.stat(`/tmp/.X11-unix/${socketName}`));
    } finally {
      child.kill("SIGKILL");
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
