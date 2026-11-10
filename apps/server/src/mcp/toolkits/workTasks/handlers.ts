import * as Agents from "../../../workTasks/WorkTaskAgentService.ts";
import { WorkTaskError } from "@t3tools/contracts";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import { readCaller } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";
import * as Collector from "../../../workTasks/SlackTaskCollector.ts";
import * as Access from "../../McpToolAccess.ts";
import { WorkTasksToolkit } from "./tools.ts";

const callerThread = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (!caller) return yield* new WorkTaskError({ reason: "agent" });
  return caller.id;
});
export const layer = Access.toLayer(WorkTasksToolkit, {
  work_chantiers_list: Access.reads(() =>
    Effect.flatMap(Tasks.WorkTaskService, (service) => service.listChantiers()),
  ),
  work_chantier_read: Access.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      return {
        chantier: yield* service.readChantier(input.id),
        tasks: (yield* service.list()).filter((task) => task.chantierId === input.id),
        types: yield* service.types(),
      };
    }),
  ),
  work_chantier_save: Access.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      return yield* (yield* Tasks.WorkTaskService).saveChantier(input, caller?.id);
    }),
  ),
  work_chantier_apply_plan: Access.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      return yield* (yield* Tasks.WorkTaskService).applyPlan(input, caller?.id);
    }),
  ),
  work_chantier_claim: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Tasks.WorkTaskService).claimChantier(yield* callerThread, input);
    }),
  ),
  work_chantier_release: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* Tasks.WorkTaskService).claimChantier(yield* callerThread, input, true);
    }),
  ),
  work_task_launch: Access.writes((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      return yield* (yield* Agents.WorkTaskAgentService).launch(input, caller?.id);
    }),
  ),
  work_tasks_list: Access.reads(() =>
    Effect.flatMap(Tasks.WorkTaskService, (service) => service.list()),
  ),
  work_task_read: Access.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      return {
        task: yield* service.read(input.id),
        messages: yield* service.messages(input.id),
        types: yield* service.types(),
      };
    }),
  ),
  work_task_claim: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      return yield* (yield* Tasks.WorkTaskService).claim(threadId, input);
    }),
  ),
  work_task_release: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      return yield* (yield* Tasks.WorkTaskService).claim(threadId, input, true);
    }),
  ),
  slack_tasks_sync: Access.writes(() =>
    Effect.flatMap(Collector.SlackTaskCollector, (service) => service.sync()),
  ),
  slack_tasks_status: Access.reads(() =>
    Effect.flatMap(Collector.SlackTaskCollector, (service) => service.status()),
  ),
});
