import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type WorkTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "./WorkTaskAgentService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

it.effect.each([false, true])(
  "launches one discussion (chantier: %s) and reuses its association",
  (inChantier) => {
    let task: WorkTask = {
      id: "task",
      ...(inChantier ? { chantierId: "chantier" } : {}),
      title: "Corriger le panier",
      notes: "Un article manque",
      attachments: [
        {
          type: "image",
          id: "task-image",
          name: "capture.png",
          mimeType: "image/png",
          sizeBytes: 340,
        },
      ],
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
      assertCanStart: () => Effect.void,
      readChantier: () =>
        Effect.succeed({
          id: "chantier",
          generation: "legacy",
          title: "Legacy",
          projectId: ProjectId.make("project"),
          status: "active",
          objective: "",
          scope: "",
          decisions: "",
          targetPeriod: "",
          sources: [],
          externalDependencies: [],
          version: 1,
          orchestratorThreadId: null,
          createdAt: "now",
          updatedAt: "now",
        }),
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
      expect(launches[0]?.initialMessage?.attachments).toEqual(task.attachments);
      expect(launches[0]?.initialMessage?.text).toContain(
        "Diagnostique puis corrige.\n\nCorriger le panier\n\nUn article manque",
      );
      const prompt = launches[0]?.initialMessage?.text ?? "";
      expect(prompt.includes("$guided-review")).toBe(inChantier);
      expect(prompt.includes("compte de test à utiliser")).toBe(inChantier);
      if (inChantier) {
        expect(prompt).toContain("ne démarre ni ne laisse tourner");
        expect(prompt).toContain("t3_project_update");
        expect(prompt).toContain("autoOpenPreview: true");
        expect(prompt).toContain("identifiant ou email");
        expect(prompt).toContain("référence exacte");
        expect(prompt).toContain("ne présente pas la recette comme prête à tester");
      }
      yield* service.launch({ ...input, expectedVersion: result.version });
      expect(launches).toHaveLength(1);
      expect((yield* service.launch(input).pipe(Effect.flip)).reason).toBe("conflict");
    }).pipe(Effect.provide(Agents.layer.pipe(Layer.provide(Layer.mergeAll(tasks, launch)))));
  },
);
