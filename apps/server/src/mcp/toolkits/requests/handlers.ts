import { AgentRequestError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Requests from "../../../agentRequests/AgentRequestService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { RequestsToolkit } from "./tools.ts";
const callerThread = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (!caller) return yield* new AgentRequestError({ reason: "agent" });
  return caller.id;
});
export const layer = Access.toLayer(RequestsToolkit, {
  request_create: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const id = yield* callerThread;
      const service = yield* Requests.AgentRequestService;
      return yield* service.create(id, input);
    }),
  ),
  request_update: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const id = yield* callerThread;
      const service = yield* Requests.AgentRequestService;
      return yield* service.update(id, input);
    }),
  ),
  request_complete: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const id = yield* callerThread;
      const service = yield* Requests.AgentRequestService;
      return yield* service.complete(id, input);
    }),
  ),
  request_list: Access.reads(() =>
    Effect.gen(function* () {
      const id = yield* callerThread;
      const service = yield* Requests.AgentRequestService;
      return (yield* service.list()).filter((request) => request.threadId === id);
    }),
  ),
});
