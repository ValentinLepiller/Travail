import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkTask, WorkTaskSaveInput, WorkTaskStatus } from "./workTask.ts";

const isStatus = Schema.is(WorkTaskStatus);
const decodeInput = Schema.decodeUnknownSync(WorkTaskSaveInput);
const decodeTask = Schema.decodeUnknownSync(WorkTask);
const encodeTask = Schema.encodeSync(WorkTask);

const input = {
  id: "task",
  expectedVersion: 0,
  title: "Action revue",
  notes: "Contexte conservé",
  status: "ready",
  projectId: null,
  agentThreadId: null,
  dueDate: null,
};

it.each(["todo", "unqualified"])("rejects the retired %s status in new commands", (status) => {
  expect(isStatus(status)).toBe(false);
  expect(() => decodeInput({ ...input, status })).toThrow();
});

it.each(["todo", "unqualified"])(
  "reads historical %s tasks as ready without losing context",
  (status) => {
    const { expectedVersion: _expectedVersion, ...fields } = input;
    const stored = { ...fields, status, version: 4, createdAt: "before", updatedAt: "after" };
    const task = decodeTask(stored);
    expect(task).toMatchObject({ ...stored, status: "ready" });
    expect(encodeTask(task).status).toBe("ready");
  },
);

it.each(["ready", "doing", "review", "done", "rejected", "merged"])(
  "keeps the current %s status available",
  (status) => expect(decodeInput({ ...input, status }).status).toBe(status),
);
