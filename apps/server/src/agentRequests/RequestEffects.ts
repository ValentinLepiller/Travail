import * as Option from "effect/Option";
import * as Agents from "../autonomousAgents/AutonomousAgentService.ts";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AgentRequestError, CommandId, MessageId, type AgentRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export class RequestEffects extends Context.Service<
  RequestEffects,
  {
    readonly execute: (request: AgentRequest) => Effect.Effect<boolean>;
    readonly notify: (request: AgentRequest) => Effect.Effect<void, AgentRequestError>;
  }
>()("t3/agentRequests/RequestEffects") {}

export const layer = Layer.effect(
  RequestEffects,
  Effect.gen(function* () {
    const agents = yield* Effect.serviceOption(Agents.AutonomousAgentService);
    const threads = yield* Threads.ThreadManagementService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return RequestEffects.of({
      execute: (request) => {
        const action = request.action;
        if (action?.kind !== "command") return Effect.succeed(true);
        return spawner
          .exitCode(
            ChildProcess.make(action.executable, [...action.args], {
              cwd: action.cwd,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.timeout("120 seconds"),
            Effect.map((code) => Number(code) === 0),
            Effect.orElseSucceed(() => false),
          );
      },
      notify: (request) =>
        Effect.gen(function* () {
          const thread = yield* threads.getThreadShell(request.threadId);
          if (!thread || thread.deletedAt !== null)
            return yield* new AgentRequestError({ reason: "agent" });
          const instruction =
            request.status === "accepted" && request.action?.kind === "agent"
              ? `\nAction autorisée à réaliser avec tes outils : ${request.action.instruction}`
              : "";
          const text = `Réponse à la requête ${request.id}\n${request.context}\n${request.question}\nVersion : ${request.version}\nDécision : ${request.status}\nRéponse : ${request.response}\nAction automatique : ${request.actionStatus}${instruction}\nUne modification demandée se fait sur la même requête avec request_update. Ne répète pas une action automatique réussie.`;
          if (
            Option.isSome(agents) &&
            (yield* agents.value.enqueueDecision(
              request.threadId,
              `${request.id}:${request.version}`,
              text,
            ))
          )
            return;
          yield* threads.sendToThread({
            projectId: thread.projectId,
            threadId: request.threadId,
            commandId: CommandId.make(`request:${request.id}:${request.version}`),
            messageId: MessageId.make(`request:${request.id}:${request.version}`),
            text: `Réponse à la requête ${request.id}\n${request.context}\n${request.question}\nVersion : ${request.version}\nDécision : ${request.status}\nRéponse : ${request.response}\nAction automatique : ${request.actionStatus}${instruction}\nUne modification demandée se fait sur la même requête avec request_update. Ne répète pas une action automatique réussie ; un résultat uncertain doit être vérifié avant toute nouvelle exécution.`,
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          });
        }).pipe(Effect.mapError(() => new AgentRequestError({ reason: "agent" }))),
    });
  }),
);
