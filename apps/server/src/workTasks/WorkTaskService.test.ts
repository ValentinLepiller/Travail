import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkTaskSaveInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";

const decodeInput = Schema.decodeUnknownEffect(WorkTaskSaveInput);

it.effect(
  "keeps tasks, permits completion and reopening, and rejects stale saves and deletes",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const input = yield* decodeInput({
        id: "test",
        expectedVersion: 0,
        title: "Préparer",
        notes: "Notes",
        status: "todo",
        projectId: null,
        agentThreadId: null,
        dueDate: "2028-02-29",
      });
      const created = yield* service.save(input);
      expect((yield* service.list())[0]).toEqual(created);
      const done = yield* service.save({
        ...input,
        expectedVersion: created.version,
        status: "done",
      });
      expect(done.status).toBe("done");
      expect((yield* service.save(input).pipe(Effect.flip)).reason).toBe("conflict");
      expect(
        (yield* service
          .delete({ id: input.id, expectedVersion: created.version })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const reopened = yield* service.save({ ...input, expectedVersion: done.version });
      expect(reopened.status).toBe("todo");
      yield* service.delete({ id: input.id, expectedVersion: reopened.version });
      expect(yield* service.list()).toEqual([]);
      expect(
        (yield* service.save({ ...input, expectedVersion: reopened.version }).pipe(Effect.flip))
          .reason,
      ).toBe("conflict");
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect("refuses unavailable project and agent assignments without creating a task", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const input = yield* decodeInput({
      id: "assignment",
      expectedVersion: 0,
      title: "Relire",
      notes: "",
      status: "todo",
      projectId: "missing",
      agentThreadId: null,
      dueDate: null,
    });
    expect((yield* service.save(input).pipe(Effect.flip)).reason).toBe("project");
    const missingAgent = yield* decodeInput({
      ...input,
      projectId: null,
      agentThreadId: "missing",
    });
    expect((yield* service.save(missingAgent).pipe(Effect.flip)).reason).toBe("agent");
    expect(yield* service.list()).toEqual([]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
