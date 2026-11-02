import { expect, it } from "@effect/vitest";
import { AgentRequest, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { NodeServices } from "@effect/platform-node";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Effects from "./RequestEffects.ts";

const request = Schema.decodeSync(AgentRequest)({
  id: "effect-test",
  context: "Livraison",
  question: "Valider ?",
  details: "",
  kind: "approval",
  action: {
    kind: "command",
    label: "vérifier",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: "/tmp",
  },
  threadId: "thread-test",
  version: 2,
  status: "accepted",
  response: "Accord",
  history: [],
  actionStatus: "succeeded",
  delivery: "pending",
  createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
});
it.effect("runs the frozen executable and reports exit status without a shell", () =>
  Effect.gen(function* () {
    const service = yield* Effects.RequestEffects;
    expect(yield* service.execute(request)).toBe(true);
    expect(
      yield* service.execute({
        ...request,
        action: {
          kind: "command",
          label: "échouer",
          executable: process.execPath,
          args: ["-e", "process.exit(2)"],
          cwd: "/tmp",
        },
      }),
    ).toBe(false);
    expect(
      yield* service.execute({
        ...request,
        action: {
          kind: "command",
          label: "absent",
          executable: "/missing-request-command",
          args: [],
          cwd: "/tmp",
        },
      }),
    ).toBe(false);
  }).pipe(
    Effect.provide(
      Effects.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.mock(Threads.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect(
  "returns approval and action outcome to the original thread with stable delivery ids and auto steering",
  () => {
    const sends: Threads.ThreadManagementSendInput[] = [];
    return Effect.gen(function* () {
      const service = yield* Effects.RequestEffects;
      yield* service.notify(request);
      yield* service.notify(request);
      expect(sends).toHaveLength(2);
      expect(sends[0]?.threadId).toBe(request.threadId);
      expect(sends[0]?.mode).toBe("auto");
      expect(sends[0]?.commandId).toBe(sends[1]?.commandId);
      expect(sends[0]?.text).toContain("succeeded");
      yield* service.notify({
        ...request,
        action: { kind: "agent", instruction: "Envoyer avec le MCP connecté" },
        actionStatus: "idle",
      });
      expect(sends[2]?.text).toContain("Action autorisée à réaliser avec tes outils");
    }).pipe(
      Effect.provide(
        Effects.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(ThreadId.make("thread-test"))),
              sendToThread: (input) =>
                Effect.sync(() => {
                  sends.push(input);
                  return {} as never;
                }),
            }),
          ),
        ),
      ),
    );
  },
);
