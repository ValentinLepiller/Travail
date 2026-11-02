import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type WorkTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "./WorkTaskAgentService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

it.effect(
  "launches one full-access discussion and reuses its association on subsequent clicks",
  () => {
    let task: WorkTask = {
      id: "task",
      title: "Corriger le panier",
      notes: "Un article manque",
      typeId: "fix",
      status: "ready",
      projectId: ProjectId.make("project"),
      agentThreadId: null,
      dueDate: null,
      version: 1,
      createdAt: "now",
      updatedAt: "now",
    };
    const launches: Launch.ThreadLaunchInput[] = [];
    const tasks = Layer.mock(Tasks.WorkTaskService)({
      list: () => Effect.succeed([task]),
      read: () => Effect.succeed(task),
      types: () =>
        Effect.succeed({
          version: 1,
          types: [{ id: "fix", name: "Fix", prompt: "Diagnostique puis corrige." }],
        }),
      messages: () => Effect.succeed([]),
      save: (input) =>
        Effect.sync(() => {
          task = { ...task, ...input, version: input.expectedVersion + 1 };
          return task;
        }),
    });
    const launch = Layer.mock(Launch.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return {
            threadId: input.threadId!,
            resumed: false,
            projection: idleThreadProjection(liveThreadShell(input.threadId!)),
          };
        }),
    });
    return Effect.gen(function* () {
      const service = yield* Agents.WorkTaskAgentService;
      const input = {
        id: task.id,
        expectedVersion: 1,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      };
      const result = yield* service.launch(input);
      expect(result.status).toBe("doing");
      expect(result.agentThreadId).toBe(launches[0]?.threadId);
      expect(launches[0]?.runtimeMode).toBe("full-access");
      expect(launches[0]?.initialMessage?.text).toBe(
        "Diagnostique puis corrige.\n\nCorriger le panier\n\nUn article manque",
      );
      yield* service.launch({ ...input, expectedVersion: result.version });
      expect(launches).toHaveLength(1);
      expect((yield* service.launch(input).pipe(Effect.flip)).reason).toBe("conflict");
    }).pipe(Effect.provide(Agents.layer.pipe(Layer.provide(Layer.mergeAll(tasks, launch)))));
  },
);
