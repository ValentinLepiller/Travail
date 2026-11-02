import * as Effect from "effect/Effect";
import { AutonomousAgentError } from "@t3tools/contracts";
import * as Agents from "../../../autonomousAgents/AutonomousAgentService.ts";
import * as Tasks from "../../../workTasks/WorkTaskService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { AutonomousAgentsToolkit } from "./tools.ts";
const ownThread = Effect.gen(function* () {
  const caller = yield* Invocation.McpInvocationContext;
  if (!caller.thread)
    return yield* new AutonomousAgentError({ message: "Un thread autonome est requis." });
  return caller.thread.threadId;
});
export const layer = Access.toLayer(AutonomousAgentsToolkit, {
  autonomous_agents_list: Access.reads(() =>
    Effect.flatMap(Agents.AutonomousAgentService, (s) => s.list()),
  ),
  autonomous_agent_configure: Access.writes((input) =>
    Effect.flatMap(Agents.AutonomousAgentService, (s) => s.command(input.command)),
  ),
  work_tasks_list: Access.reads(() => Effect.flatMap(Tasks.WorkTaskService, (s) => s.list())),
  autonomous_agent_reply: Access.writes((input) =>
    Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      yield* service.reply(yield* ownThread, input.id, input.text);
    }),
  ),
  autonomous_agent_finish: Access.writes((input) =>
    Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      yield* service.finish(yield* ownThread, input.memory, input.response);
    }),
  ),
  autonomous_agent_ask: Access.writes((input) =>
    Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      yield* service.ask(yield* ownThread, input.target, input.text);
    }),
  ),
  work_task_save: Access.writes((input) =>
    Effect.gen(function* () {
      const caller = yield* Invocation.McpInvocationContext;
      const service = yield* Tasks.WorkTaskService;
      return yield* service.save(input, caller.thread?.threadId);
    }),
  ),
});
