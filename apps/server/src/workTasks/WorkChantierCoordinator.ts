import { sha256Hex } from "@t3tools/shared/sha256";
import * as Requests from "../agentRequests/AgentRequestService.ts";
import {
  AgentRequest,
  type ChantierNotifySubjectInput,
  type ChantierApprovalInput,
  CommandId,
  type RunId,
  MessageId,
  ThreadId,
  WorkTaskError,
  type WorkChantier,
  type WorkTask,
  type WorkChantierLaunchInput,
  ChantierV2Command,
  ChantierNotifyInput,
  type PullRequestRef,
  type ModelSelection,
  workTaskBlockers,
  chantierParallelism,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as TaskAgents from "./WorkTaskAgentService.ts";
import { admissionMessagePrefix, taskLaunchCommandId } from "./taskAdmission.ts";
import { canApplyIndependentApproval, taskDefinition } from "./chantierV2Policy.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "../autonomousAgents/AutonomousAgentService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";

const notificationCodec = Schema.fromJsonString(ChantierNotifyInput);
const encodeNotification = Schema.encodeEffect(notificationCodec);
const decodeNotification = Schema.decodeUnknownEffect(notificationCodec);

function pullRequestRef(chantier: WorkChantier, url: string): PullRequestRef | null {
  const parsed = new URL(url);
  const match = /^(.*?)\/(?:pull|pulls|pull-requests|(?:-\/)?merge_requests)\/(\d+)\/?$/.exec(
    parsed.pathname,
  );
  if (!match) return null;
  return {
    projectId: chantier.projectId,
    repository: match[1]!.replace(/^\//, ""),
    number: Number(match[2]),
    host: parsed.hostname,
  };
}
export class WorkChantierCoordinator extends Context.Service<
  WorkChantierCoordinator,
  {
    readonly dispatchReady: (
      id: string,
      modelSelection: ModelSelection,
    ) => Effect.Effect<void, WorkTaskError>;
    readonly requestApproval: (
      input: ChantierApprovalInput,
      callerThreadId: ThreadId,
    ) => Effect.Effect<AgentRequest, WorkTaskError>;
    readonly launch: (input: WorkChantierLaunchInput) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly command: (
      input: ChantierV2Command,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<WorkChantier, WorkTaskError>;
    readonly notifySubject: (
      input: ChantierNotifySubjectInput,
    ) => Effect.Effect<void, WorkTaskError>;
    readonly notify: (input: ChantierNotifyInput) => Effect.Effect<void, WorkTaskError>;
  }
>()("t3/workTasks/WorkChantierCoordinator") {}
const make = Effect.gen(function* () {
  const tasks = yield* Tasks.WorkTaskService;
  const threadLauncher = yield* ThreadLaunch.ThreadLaunchService;
  const taskAgents = yield* TaskAgents.WorkTaskAgentService;
  const agents = yield* Agents.AutonomousAgentService;
  const threads = yield* Threads.ThreadManagementService;
  const requests = yield* Requests.AgentRequestService;
  const prs = yield* PullRequests.PullRequestService;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const failure = () => new WorkTaskError({ reason: "agent" });
  const dispatchReady = Effect.fn("WorkChantierCoordinator.dispatchReady")(function* (
    id: string,
    modelSelection: ModelSelection,
  ) {
    const chantier = yield* tasks.readChantier(id);
    if (chantier.status !== "active" || !chantier.v2?.framingApproved || chantier.v2.stopped)
      return;
    const cards = yield* tasks.list(id);
    const approvals = new Map(
      chantier.v2.reviews.map((review) => [review.taskId, review.approvedDefinition]),
    );
    const approvedAndUnblocked = (card: WorkTask) => {
      const definition = approvals.get(card.id);
      return (
        definition != null &&
        definition === taskDefinition(card) &&
        !workTaskBlockers(card, cards, chantier.externalDependencies).length
      );
    };
    let transientFailure: WorkTaskError | undefined;
    if (chantier.v2.dispatchModelSelection) {
      const preparing = yield* sql<{ task_id: string; run_id: RunId }>`
        SELECT t.id AS task_id, r.run_id FROM work_tasks t
        JOIN orchestration_v2_projection_runs r ON r.thread_id=json_extract(t.payload_json,'$.agentThreadId')
        WHERE json_extract(t.payload_json,'$.chantierId')=${id}
        AND json_extract(t.payload_json,'$.status')='doing' AND r.status='preparing'
        AND r.thread_id='task-' || t.id
        AND json_extract(r.payload_json,'$.userMessageId')=${admissionMessagePrefix} || r.thread_id`.pipe(
        Effect.mapError(failure),
      );
      yield* Effect.forEach(
        preparing,
        ({ task_id, run_id }) =>
          Effect.gen(function* () {
            const card = cards.find((c) => c.id === task_id);
            if (!card?.agentThreadId || !approvedAndUnblocked(card)) return;
            yield* threadLauncher
              .resumePreparation({
                commandId: taskLaunchCommandId(card.agentThreadId),
                threadId: card.agentThreadId,
                runId: run_id,
              })
              .pipe(
                Effect.catch((cause) => {
                  transientFailure = failure();
                  return Effect.logWarning("Recovering chantier task preparation failed", {
                    taskId: task_id,
                    cause,
                  });
                }),
              );
          }),
        { concurrency: "unbounded", discard: true },
      );
    }
    const candidates = cards.filter(
      (card) =>
        !card.agentThreadId &&
        (card.status === "ready" || (card.status === "doing" && card.pendingLaunch)) &&
        approvedAndUnblocked(card),
    );
    if (!candidates.length) {
      if (transientFailure) return yield* Effect.fail(transientFailure);
      return;
    }
    const policy = yield* tasks.chantierPolicy(chantier.projectId);
    // Recover previously admitted work first. Admission checks the live project limit transactionally.
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.pendingLaunch)) - Number(Boolean(a.pendingLaunch)) ||
        (a.id < b.id ? -1 : 1),
    );
    yield* Effect.forEach(
      candidates,
      (card) =>
        taskAgents
          .launch({
            id: card.id,
            expectedVersion: card.version,
            modelSelection: card.pendingLaunch ?? modelSelection,
          })
          .pipe(
            Effect.catch((error) => {
              if (error.reason === "agent" || error.reason === "storage") transientFailure = error;
              if (
                ["parallelism", "conflict", "approval", "dependencies", "preparation"].includes(
                  error.reason,
                )
              )
                return Effect.void;
              return Effect.logWarning("Chantier task dispatch failed", {
                chantierId: id,
                taskId: card.id,
                reason: error.reason,
              });
            }),
          ),
      { concurrency: chantierParallelism(policy, chantier.v2), discard: true },
    );
    if (transientFailure) return yield* Effect.fail(transientFailure);
  });
  const launch = Effect.fn(function* (input: WorkChantierLaunchInput) {
    const chantier = yield* tasks.readChantier(input.id);
    if (chantier.generation !== "v2" || !chantier.v2)
      return yield* new WorkTaskError({ reason: "generation" });
    if (chantier.version !== input.expectedVersion)
      return yield* new WorkTaskError({ reason: "conflict" });
    if (chantier.status === "done" || chantier.status === "paused")
      return yield* new WorkTaskError({ reason: "approval" });
    const policy = yield* tasks.chantierPolicy(chantier.projectId);
    const existing = (yield* agents.list(true).pipe(Effect.mapError(failure))).find(
      (a) => a.id === chantier.v2!.chefAgentId,
    );
    if (existing || chantier.orchestratorThreadId) return chantier;
    yield* agents
      .command({
        type: "save",
        config: {
          id: chantier.v2.chefAgentId,
          kind: "chantier-chef",
          chantierId: chantier.id,
          projectId: chantier.projectId,
          name: `Chef · ${chantier.title}`.slice(0, 100),
          mission: `Chantier ${chantier.id} uniquement. ${policy.trackingHabits}\nSources : ${policy.sourceRules}\nDélégations précises : ${policy.delegations || "Aucune"}. Toute contradiction exige arbitrage de Valentin.`,
          trigger: "interval",
          intervalSeconds: policy.intervalSeconds,
          wakeOnTaskChanges: true,
          modelSelection: input.modelSelection,
          x: 0,
          y: 0,
        },
      })
      .pipe(Effect.mapError(failure));
    yield* agents
      .command({ type: "resume", id: chantier.v2.chefAgentId })
      .pipe(Effect.mapError(failure));
    return chantier;
  });
  const commandCodec = Schema.fromJsonString(ChantierV2Command);
  const encodeCommand = Schema.encodeEffect(commandCodec);
  const requestApproval = Effect.fn(function* (
    input: ChantierApprovalInput,
    callerThreadId: ThreadId,
  ) {
    const c = yield* tasks.readChantier(input.command.id);
    const chef = (yield* agents.list().pipe(Effect.mapError(failure))).find(
      (a) => a.id === c.v2?.chefAgentId && a.currentThreadId === callerThreadId,
    );
    if (
      (!chef && (c.generation !== "v2" || c.orchestratorThreadId !== callerThreadId)) ||
      ![
        "approveFraming",
        "approveTask",
        "humanReview",
        "resume",
        "stop",
        "close",
        "reopen",
        "deploymentGo",
      ].includes(input.command.type) ||
      input.command.approvalRequestId
    )
      return yield* new WorkTaskError({ reason: "approval" });
    if (c.version !== input.command.expectedVersion)
      return yield* new WorkTaskError({ reason: "conflict" });
    const task = "taskId" in input.command ? yield* tasks.read(input.command.taskId) : null;
    if (
      task &&
      (task.chantierId !== c.id ||
        !("expectedTaskVersion" in input.command) ||
        task.version !== input.command.expectedTaskVersion)
    )
      return yield* new WorkTaskError({ reason: "conflict" });
    const project = (yield* sql<{
      title: string;
    }>`SELECT title FROM projection_projects WHERE project_id=${c.projectId}`.pipe(
      Effect.mapError(failure),
    ))[0];
    const labels: Record<string, string> = {
      approveFraming: "le cadrage proposé",
      approveTask: "le lancement de cette tâche et, pour du code, sa branche et sa PR",
      humanReview: "le merge du dernier code présenté",
      resume: "la reprise",
      stop: "l’arrêt immédiat des agents",
      close: "la clôture après bilan",
      reopen: "la réouverture",
      deploymentGo: "le déploiement dans l’environnement indiqué",
    };
    const material = yield* encodeCommand(input.command).pipe(Effect.mapError(failure));
    const review = c.v2?.reviews.find((r) => r.taskId === task?.id);
    const details = `Objectif : ${c.objective}\nPérimètre : ${c.scope}\nCritères : ${c.v2?.completionCriteria ?? ""}\n${task ? `Tâche : ${task.title}\n${task.notes}\nCritères : ${task.acceptanceCriteria ?? ""}` : ""}\nBilan : ${c.v2?.finalReview ?? ""}\nPR et révision : ${[review?.pullRequestUrl, review?.head].filter(Boolean).join(" ")}\nAccord précis : ${material}`;
    if (details.length > 50000) return yield* new WorkTaskError({ reason: "approval" });
    return yield* requests
      .create(callerThreadId, {
        id: input.requestId,
        kind: "approval",
        context: `Dans le projet « ${project?.title ?? c.title} », Valentin et le Chef suivent le chantier « ${c.title} ». Une décision attend sa validation avant de poursuivre.`,
        question: `Approuves-tu cette opération pour « ${task?.title ?? c.title} » : ${input.command.type === "humanReview" && !input.command.approved ? "le retrait de l’accord de merge" : labels[input.command.type]} ?`,
        details,
        action: {
          kind: "agent",
          instruction: `Applique work_chantier_v2_command avec approvalRequestId=${input.requestId}, exactement la commande validée, puis préserve les autres validations.`,
        },
        chantierApproval: input.command,
      })
      .pipe(Effect.mapError(failure));
  });
  const command = Effect.fn(function* (input: ChantierV2Command, callerThreadId?: ThreadId) {
    const current = yield* tasks.readChantier(input.id);
    if (
      "taskId" in input &&
      ["pullRequest", "humanReview", "chefReview", "merged"].includes(input.type)
    ) {
      const review = current.v2?.reviews.find((r) => r.taskId === input.taskId);
      const url = input.type === "pullRequest" ? input.url : review?.pullRequestUrl;
      const ref = url ? pullRequestRef(current, url) : null;
      if (!ref) return yield* new WorkTaskError({ reason: "approval" });
      yield* prs.invalidate({ reference: ref }).pipe(Effect.mapError(failure));
      const detail = yield* prs.detail(ref).pipe(Effect.mapError(failure));
      const head =
        input.type === "pullRequest" || input.type === "merged" ? input.head : review?.head;
      if (
        !head ||
        detail.headSha !== head ||
        (input.type === "merged" && detail.state !== "merged")
      )
        return yield* new WorkTaskError({ reason: "approval" });
    }
    let actor = callerThreadId;
    let validatedCommand = input;
    if (callerThreadId && input.approvalRequestId) {
      const request = (yield* requests.list().pipe(Effect.mapError(failure))).find(
        (r) => r.id === input.approvalRequestId,
      );
      const { approvalRequestId: _approvalRequestId, ...approvedCommand } = input;
      const bound = request?.chantierApproval;
      if (
        !request ||
        request.status !== "accepted" ||
        request.threadId !== callerThreadId ||
        !bound ||
        (yield* encodeCommand(bound).pipe(Effect.mapError(failure))) !==
          (yield* encodeCommand(approvedCommand).pipe(Effect.mapError(failure)))
      )
        return yield* new WorkTaskError({ reason: "approval" });
      if (canApplyIndependentApproval(current, bound)) {
        validatedCommand = { ...input, expectedVersion: current.version };
      }
      actor = undefined;
    }
    let next = yield* tasks.commandChantierV2(validatedCommand, actor);
    const chefId = next.v2!.chefAgentId;
    const chef = (yield* agents.list(true).pipe(Effect.mapError(failure))).find(
      (a) => a.id === chefId,
    );
    if (chef && ["pause", "close"].includes(input.type))
      yield* agents.command({ type: "sleep", id: chefId }).pipe(Effect.mapError(failure));
    if (input.type === "stop") {
      if (chef) yield* agents.command({ type: "stop", id: chefId }).pipe(Effect.mapError(failure));
      for (const task of (yield* tasks.list()).filter(
        (t) =>
          t.chantierId === next.id && ["doing", "review"].includes(t.status) && t.agentThreadId,
      )) {
        yield* threads
          .interruptThread({
            projectId: next.projectId,
            threadId: task.agentThreadId!,
            commandId: CommandId.make(`chantier-stop:${next.id}:${next.version}:${task.id}`),
          })
          .pipe(Effect.mapError(failure));
      }
    }
    if (chef && ["resume", "reopen"].includes(input.type))
      yield* agents.command({ type: "resume", id: chefId }).pipe(Effect.mapError(failure));
    // Two independent approvals are sufficient; this path does not ask for a third merge consent.
    if (
      (input.type === "humanReview" || input.type === "chefReview") &&
      input.approved &&
      next.status === "active"
    ) {
      const review = next.v2!.reviews.find((r) => r.taskId === input.taskId)!;
      if (
        review.head &&
        review.humanHead === review.head &&
        review.chefHead === review.head &&
        !review.mergedHead
      ) {
        const ref = pullRequestRef(next, review.pullRequestUrl!)!;
        const beforeMerge = yield* prs.detail(ref).pipe(Effect.mapError(failure));
        if (beforeMerge.provider !== "github")
          return yield* new WorkTaskError({ reason: "approval" });
        yield* prs
          .runAction({ ...ref, action: "merge", expectedHeadSha: review.head })
          .pipe(Effect.mapError(failure));
        yield* prs.invalidate({ reference: ref }).pipe(Effect.mapError(failure));
        const detail = yield* prs.detail(ref).pipe(Effect.mapError(failure));
        if (detail.state === "merged" && detail.headSha === review.head)
          next = yield* tasks.commandChantierV2(
            {
              id: next.id,
              expectedVersion: next.version,
              type: "merged",
              taskId: input.taskId,
              expectedTaskVersion: input.expectedTaskVersion,
              head: review.head,
            },
            callerThreadId,
          );
      }
    }
    return next;
  });
  const notify = Effect.fn(function* (input: ChantierNotifyInput) {
    const chantier = yield* tasks.readChantier(input.id);
    if ((chantier.generation ?? "legacy") !== input.generation)
      return yield* new WorkTaskError({ reason: "generation" });
    const payload = yield* encodeNotification(input).pipe(Effect.mapError(failure));
    yield* sql`INSERT INTO work_chantier_notifications(chantier_id,notification_id,payload_json) VALUES(${input.id},${input.notificationId},${payload}) ON CONFLICT DO NOTHING`.pipe(
      Effect.mapError(failure),
    );
    const stored = (yield* sql<{
      payload_json: string;
      delivered: number;
    }>`SELECT payload_json,delivered FROM work_chantier_notifications WHERE chantier_id=${input.id} AND notification_id=${input.notificationId}`.pipe(
      Effect.mapError(failure),
    ))[0]!;
    if (stored.payload_json !== payload) return yield* new WorkTaskError({ reason: "conflict" });
    if (stored.delivered) return;
    const key = `chantier-notify:${input.id}:${input.notificationId}`;
    const text = `Information ponctuelle, sans autorisation nouvelle ; conserve pauses et validations en attente.\n${input.text}`;
    if (chantier.generation === "v2" && !chantier.orchestratorThreadId) {
      if (
        !(yield* agents.list().pipe(Effect.mapError(failure))).some(
          (a) => a.id === chantier.v2!.chefAgentId,
        )
      )
        return yield* new WorkTaskError({ reason: "agent" });
      yield* agents
        .command({
          type: "message",
          id: chantier.v2!.chefAgentId,
          messageId: input.notificationId,
          text,
        })
        .pipe(Effect.mapError(failure));
    } else {
      if (!chantier.orchestratorThreadId) return yield* new WorkTaskError({ reason: "agent" });
      yield* threads
        .sendToThread({
          projectId: chantier.projectId,
          threadId: chantier.orchestratorThreadId,
          commandId: CommandId.make(key),
          messageId: MessageId.make(key),
          mode: "queue",
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(failure));
    }
    yield* sql`UPDATE work_chantier_notifications SET delivered=1 WHERE chantier_id=${input.id} AND notification_id=${input.notificationId}`.pipe(
      Effect.mapError(failure),
    );
  });
  const notifySubject = Effect.fn(function* (input: ChantierNotifySubjectInput) {
    const subject = (yield* sql<{
      title: string;
      summary: string;
      entries: number;
      end_cursor: number;
    }>`SELECT title,summary,(SELECT COALESCE(MAX(rowid),0) FROM inbox_subject_entries WHERE subject_id=s.id) AS end_cursor,(SELECT count(*) FROM inbox_subject_entries WHERE subject_id=s.id) AS entries FROM inbox_subjects s WHERE id=${input.subjectId}`.pipe(
      Effect.mapError(failure),
    ))[0];
    if (!subject || subject.entries !== input.expectedEntries)
      return yield* new WorkTaskError({ reason: "conflict" });
    const cursor =
      (yield* sql<{
        last_entry_row: number;
      }>`SELECT last_entry_row FROM work_chantier_subject_cursors WHERE chantier_id=${input.id} AND subject_id=${input.subjectId}`.pipe(
        Effect.mapError(failure),
      ))[0]?.last_entry_row ?? 0;
    const notificationId = sha256Hex(`${input.subjectId}:${cursor}`);
    const frozen = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM work_chantier_notifications WHERE chantier_id=${input.id} AND notification_id=${notificationId}`.pipe(
      Effect.mapError(failure),
    ))[0];
    let notification: ChantierNotifyInput;
    if (frozen)
      notification = yield* decodeNotification(frozen.payload_json).pipe(Effect.mapError(failure));
    else {
      const entries = yield* sql<{
        entry_id: string;
        cursor: number;
      }>`SELECT entry_id,rowid AS cursor FROM inbox_subject_entries WHERE subject_id=${input.subjectId} AND rowid>${cursor} AND rowid<=${subject.end_cursor} ORDER BY rowid LIMIT 201`.pipe(
        Effect.mapError(failure),
      );
      if (!entries.length) return;
      if (entries.length > 200) return yield* new WorkTaskError({ reason: "notificationLimit" });
      const text = `Sujet Inbox « ${subject.title} » (${input.subjectId}).\n${subject.summary}\nMessages originaux de cet envoi (lis chaque original avec inbox_read, puis évalue son impact dans le périmètre autorisé) :\n${entries.map((e) => e.entry_id).join("\n")}\nLes messages futurs nécessiteront un nouvel appui humain sur Informer le chantier.`;
      if (text.length > 20000) return yield* new WorkTaskError({ reason: "notificationLimit" });
      notification = {
        id: input.id,
        generation: input.generation,
        subjectId: input.subjectId,
        sourceCursor: entries.at(-1)!.cursor,
        notificationId,
        text,
      };
    }
    if (notification.generation !== input.generation)
      return yield* new WorkTaskError({ reason: "generation" });
    yield* notify(notification);
    yield* sql`INSERT INTO work_chantier_subject_cursors(chantier_id,subject_id,last_entry_row) VALUES(${input.id},${input.subjectId},${notification.sourceCursor!}) ON CONFLICT(chantier_id,subject_id) DO UPDATE SET last_entry_row=MAX(last_entry_row,excluded.last_entry_row)`.pipe(
      Effect.mapError(failure),
    );
  });
  return WorkChantierCoordinator.of({
    dispatchReady,
    notifySubject: (input) => notifySubject(input).pipe(lock.withPermits(1)),
    requestApproval: (input, caller) => requestApproval(input, caller).pipe(lock.withPermits(1)),
    launch: (input) => launch(input).pipe(lock.withPermits(1)),
    command: (input, caller) => command(input, caller).pipe(lock.withPermits(1)),
    notify: (input) => notify(input).pipe(lock.withPermits(1)),
  });
});
export const layer = Layer.effect(WorkChantierCoordinator, make);
