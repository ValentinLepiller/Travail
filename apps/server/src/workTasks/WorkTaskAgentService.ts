import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  CommandId,
  ThreadId,
  WorkTaskError,
  type WorkChantier,
  type WorkChantierLaunchInput,
  isClosedWorkTaskStatus,
  type WorkTaskLaunchInput,
  type WorkTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Tasks from "./WorkTaskService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
export class WorkTaskAgentService extends Context.Service<
  WorkTaskAgentService,
  {
    readonly launchChantier: (
      input: WorkChantierLaunchInput,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly launch: (input: WorkTaskLaunchInput) => Effect.Effect<WorkTask, WorkTaskError>;
  }
>()("t3/workTasks/WorkTaskAgentService") {}
export const layer = Layer.effect(
  WorkTaskAgentService,
  Effect.gen(function* () {
    const tasks = yield* Tasks.WorkTaskService;
    const launcher = yield* Launch.ThreadLaunchService;
    const lock = yield* Semaphore.make(1);
    return WorkTaskAgentService.of({
      launchChantier: (input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const chantier = yield* tasks.readChantier(input.id);
            if (chantier.version !== input.expectedVersion)
              return yield* new WorkTaskError({ reason: "conflict" });
            if (chantier.orchestratorThreadId) return chantier;
            const threadId = ThreadId.make(`chantier-${chantier.id}`);
            yield* launcher
              .launch({
                commandId: CommandId.make(`chantier-launch:${chantier.id}`),
                threadId,
                reuseExistingThread: true,
                projectId: chantier.projectId,
                title: `${chantier.title} · Orchestrateur`.slice(0, 200),
                modelSelection: input.modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                createdBy: "user",
                creationSource: "web",
                initialMessage: {
                  attachments: [],
                  text: [
                    `Tu es l’orchestrateur permanent du chantier « ${chantier.title} » (id : ${chantier.id}).`,
                    "À chaque reprise, lis work_chantier_read pour retrouver le périmètre, les décisions, les sources et les tâches actuels. Consulte les discussions associées avec t3_thread_read pour vérifier les résultats et blocages.",
                    "Cadre le résultat avec Valentin, propose un découpage en tâches et prérequis, puis utilise work_chantier_apply_plan pour enregistrer le plan autorisé de manière atomique. Préserve les tâches, discussions et décisions existantes. N’invente aucune règle métier manquante. Les dépendances externes appartiennent à leurs responsables.",
                    "Tu pilotes le chantier : les tâches exécutables ont leur propre discussion. Ne revendique pas leurs tâches avec work_task_claim. Utilise work_task_launch uniquement dans le périmètre d’exécution autorisé. Une tâche à valider n’est pas livrée ; seules les tâches done débloquent leurs dépendants. Ne lance rien lors du simple découpage.",
                    "Quand une modification est demandée, analyse son impact sur les tâches en cours, conserve les travaux et actualise scope, decisions, acceptanceCriteria et les dépendances. Utilise milestone pour reporter un lot sans supprimer ses tâches. Réponds aux questions et demandes de changement tout au long du chantier.",
                    `Objectif : ${chantier.objective}`,
                    `Périmètre : ${chantier.scope}`,
                  ].join("\n\n"),
                },
              })
              .pipe(Effect.mapError(() => new WorkTaskError({ reason: "agent" })));
            const latest = yield* tasks.readChantier(chantier.id);
            return yield* tasks.claimChantier(threadId, {
              id: chantier.id,
              expectedVersion: latest.version,
            });
          }),
        ),
      launch: (input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const task = yield* tasks.read(input.id);
            if (
              !task ||
              task.version !== input.expectedVersion ||
              isClosedWorkTaskStatus(task.status)
            )
              return yield* new WorkTaskError({ reason: "conflict" });
            if (task.agentThreadId) return task;
            if (task.chantierId || task.dependsOn?.length || task.externalDependsOn?.length)
              yield* tasks.assertCanStart(task);
            if (task.status !== "ready") return yield* new WorkTaskError({ reason: "preparation" });
            if (!task.projectId) return yield* new WorkTaskError({ reason: "project" });
            const config = yield* tasks.types();
            const type = config.types.find((t) => t.id === task.typeId);
            const messages = yield* tasks.messages(task.id);
            const text = [
              type?.prompt,
              task.title,
              task.notes,
              task.acceptanceCriteria
                ? `Critères de validation : ${task.acceptanceCriteria}`
                : null,
              task.chantierId
                ? `Cette tâche appartient au chantier ${task.chantierId}. Lis work_chantier_read avant de commencer pour retrouver le périmètre courant, les décisions et les prérequis. Ta discussion exécute uniquement la tâche ${task.id}. Signale les blocages et résultats dans ses notes et passe à review pour validation ; ne déclare pas les prérequis livrés sans preuve.`
                : null,
              ...messages.map((m) => `Slack · ${m.authorId}\n${m.text}`),
            ]
              .filter(Boolean)
              .join("\n\n");
            const threadId = ThreadId.make(`task-${yield* randomUuidV4}`);
            // Advance the version before launch to reject concurrent edits based on this snapshot.
            const reserved = yield* tasks.save({
              ...task,
              agentThreadId: task.agentThreadId,
              expectedVersion: task.version,
            });
            yield* launcher
              .launch({
                commandId: CommandId.make(`task-launch:${threadId}`),
                threadId,
                projectId: task.projectId,
                title: task.title.slice(0, 200),
                modelSelection: input.modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                createdBy: "user",
                creationSource: "web",
                initialMessage: { text, attachments: [] },
              })
              .pipe(Effect.mapError(() => new WorkTaskError({ reason: "agent" })));
            return yield* tasks.save({
              ...reserved,
              status: "doing",
              agentThreadId: threadId,
              expectedVersion: reserved.version,
            });
          }),
        ),
    });
  }),
);
