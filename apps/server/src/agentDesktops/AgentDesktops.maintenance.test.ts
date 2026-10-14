// @effect-diagnostics nodeBuiltinImport:off -- Native fixture directories stay outside live application state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { AgentDesktopError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";

import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as AgentDesktops from "./AgentDesktops.ts";
import { AgentDesktopRuntime } from "./AgentDesktopRuntime.ts";

const directory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-desktop-gate-"))),
  (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
);
const setup = Effect.gen(function* () {
  const gate = yield* RuntimeAdmission.RuntimeAdmission;
  for (const hook of RuntimeAdmission.REQUIRED_HOOKS.filter((hook) => hook !== "desktops"))
    yield* gate.registerHook(hook);
  const desktops = yield* AgentDesktops.AgentDesktops;
  const probe = () =>
    desktops.activeCount.pipe(
      Effect.map((activeDesktops) => ({ activeWork: 0, activeVoice: 0, activeDesktops })),
    );
  return { gate, desktops, probe };
});

const layers = (rootDirectory: string) =>
  AgentDesktops.layer({ rootDirectory }).pipe(Layer.provideMerge(RuntimeAdmission.layer));

describe("Agent desktop maintenance admission", () => {
  it.effect("blocks all new human/agent mutations while keeping reads and cleanup available", () =>
    Effect.gen(function* () {
      const root = yield* directory;
      yield* Effect.gen(function* () {
        const { gate, desktops, probe } = yield* setup;
        assert.include((yield* gate.snapshot).hooks, "desktops");
        yield* gate.quiesce("update", probe);
        const target = { sessionId: "absent", revision: 0 };
        const input = { ...target, windowId: "0", kind: "key" as const, key: "Return" };
        const mutations: readonly Effect.Effect<unknown, AgentDesktopError>[] = [
          desktops.acquire("thread"),
          desktops.ensure("thread"),
          desktops.launch("thread", "message", target),
          desktops.input("thread", "agent", input),
          desktops.input("thread", "human", input),
          desktops.transfer("thread", target, "human"),
        ];
        for (const effect of mutations)
          assert.equal((yield* Effect.flip(effect.pipe(Effect.asVoid))).code, "maintenance_active");
        assert.equal(yield* desktops.activeCount, 0);
        assert.deepEqual(yield* desktops.list("thread"), []);
        assert.equal((yield* Effect.flip(desktops.status("thread"))).code, "not_found");
        assert.equal((yield* Effect.flip(desktops.capture("thread"))).code, "not_found");
        assert.equal((yield* Effect.flip(desktops.close("thread"))).code, "not_found");
        yield* gate.release("update");
        assert.equal((yield* Effect.flip(desktops.ensure(" "))).code, "invalid_input");
      }).pipe(Effect.provide(layers(root)));
    }).pipe(Effect.scoped),
  );

  it("counts a queued acquisition synchronously until its native promise settles", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-desktop-pending-"));
    const runtime = new AgentDesktopRuntime({ rootDirectory: root });
    try {
      const pending = runtime.ensure(" ");
      assert.equal(runtime.activeCount(), 1);
      await pending.catch(() => undefined);
      assert.equal(runtime.activeCount(), 0);
    } finally {
      await runtime.dispose();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.T3_TEST_AGENT_DESKTOPS !== "1")("Real X11 maintenance boundary", () => {
  it.effect(
    "a human desktop blocks upgrade without being closed; closure makes zero authoritative",
    () =>
      Effect.gen(function* () {
        const root = yield* directory;
        yield* Effect.gen(function* () {
          const { gate, desktops, probe } = yield* setup;
          const opened = yield* desktops.acquire("thread");
          const owner = `thread/${opened.leaseId}`;
          const human = yield* desktops.transfer(owner, opened.status, "human");
          assert.equal(yield* desktops.activeCount, 1);
          assert.equal((yield* Effect.flip(gate.quiesce("update", probe))).code, "busy");
          assert.equal((yield* desktops.status(owner)).sessionId, opened.status.sessionId);
          assert.equal((yield* gate.snapshot).operationId, null);
          yield* desktops.close(owner, "human", human);
          assert.equal(yield* desktops.activeCount, 0);
          yield* gate.quiesce("update", probe);
          assert.equal((yield* Effect.flip(desktops.acquire("thread"))).code, "maintenance_active");
        }).pipe(Effect.provide(layers(root)));
      }).pipe(Effect.scoped),
    { timeout: 15_000 },
  );

  it.effect(
    "an interrupted Effect observer cannot hide a queued native acquisition",
    () =>
      Effect.gen(function* () {
        const root = yield* directory;
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() => new AgentDesktopRuntime({ rootDirectory: root })),
          (value) => Effect.promise(() => value.dispose()),
        );
        const gate = yield* RuntimeAdmission.RuntimeAdmission;
        for (const hook of RuntimeAdmission.REQUIRED_HOOKS) yield* gate.registerHook(hook);
        const pending = runtime.ensure("cancelled-observer");
        const fiber = yield* Effect.forkChild(gate.admit(Effect.promise(() => pending)));
        yield* Fiber.interrupt(fiber);
        assert.equal(runtime.activeCount(), 1);
        assert.equal(
          (yield* Effect.flip(
            gate.quiesce("update", () =>
              Effect.sync(() => ({
                activeWork: 0,
                activeVoice: 0,
                activeDesktops: runtime.activeCount(),
              })),
            ),
          )).code,
          "busy",
        );
        yield* Effect.promise(() => pending);
        assert.equal(runtime.activeCount(), 1);
        yield* Effect.promise(() => runtime.close("cancelled-observer"));
        assert.equal(runtime.activeCount(), 0);
      }).pipe(Effect.scoped, Effect.provide(RuntimeAdmission.layer)),
    { timeout: 15_000 },
  );

  it.effect(
    "concurrent acquisition and quiescence never both succeed",
    () =>
      Effect.gen(function* () {
        const root = yield* directory;
        yield* Effect.gen(function* () {
          const { gate, desktops, probe } = yield* setup;
          const [opened, quiesced] = yield* Effect.all(
            [
              desktops.acquire("thread").pipe(Effect.result),
              gate.quiesce("race", probe).pipe(Effect.result),
            ],
            { concurrency: "unbounded" },
          );
          assert.isFalse(opened._tag === "Success" && quiesced._tag === "Success");
          if (opened._tag === "Success") {
            assert.equal(quiesced._tag, "Failure");
            yield* desktops.close(`thread/${opened.success.leaseId}`);
          } else {
            assert.equal(quiesced._tag, "Success");
            assert.equal(yield* desktops.activeCount, 0);
            yield* gate.release("race");
          }
        }).pipe(Effect.provide(layers(root)));
      }).pipe(Effect.scoped),
    { timeout: 15_000 },
  );
});
