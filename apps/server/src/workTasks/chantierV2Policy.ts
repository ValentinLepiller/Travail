import { sha256Hex } from "@t3tools/shared/sha256";
import * as Schema from "effect/Schema";
import {
  WorkTaskError,
  type WorkTask,
  type WorkChantier,
  type ChantierV2Command,
  type ChantierV2State,
  type ChantierProjectPolicy,
} from "@t3tools/contracts";

export const initialChantierV2 = (id: string): ChantierV2State => ({
  chefAgentId: `chantier-v2-${sha256Hex(id).slice(0, 32)}`,
  framingApproved: false,
  completionCriteria: "",
  interfaceExpected: true,
  specifications: "",
  prototype: { status: "pending", url: null, codeReference: "", notes: "", annotations: [] },
  stages: [],
  memory: "",
  finalReview: "",
  stopped: false,
  reviews: [],
});

const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

// The definition includes instructions; progress and thread association do not grant new scope.
export const taskDefinition = (task: WorkTask) =>
  sha256Hex(
    encodeDefinition([
      task.title,
      task.notes,
      task.projectId,
      task.chantierId,
      task.typeId ?? null,
      task.acceptanceCriteria ?? "",
      task.milestone ?? "",
      task.dependsOn ?? [],
      task.externalDependsOn ?? [],
      task.sources ?? [],
      task.attachments ?? [],
    ]),
  );
export const defaultChantierPolicy = (
  projectId: ChantierProjectPolicy["projectId"],
): ChantierProjectPolicy => ({
  projectId,
  expectedVersion: 0,
  maxParallel: 1,
  intervalSeconds: 900,
  trackingHabits: "",
  sourceRules: "",
  deploymentEnvironments: [],
  delegations: "",
});

export function decideChantierV2(
  chantier: WorkChantier,
  command: ChantierV2Command,
  tasks: readonly WorkTask[],
  actor: "human" | "chef",
  policy: ChantierProjectPolicy,
): { chantier: WorkChantier; task?: WorkTask } | WorkTaskError {
  const fail = () => new WorkTaskError({ reason: "approval" });
  if (chantier.generation !== "v2" || !chantier.v2)
    return new WorkTaskError({ reason: "generation" });
  if (chantier.version !== command.expectedVersion)
    return new WorkTaskError({ reason: "conflict" });
  let v2 = { ...chantier.v2 };
  let status = chantier.status;
  const humanOnly = [
    "approveFraming",
    "approveTask",
    "humanReview",
    "resume",
    "stop",
    "close",
    "reopen",
    "deploymentGo",
  ];
  if (actor !== "human" && humanOnly.includes(command.type)) return fail();
  if (status === "done" && !["reopen", "memory"].includes(command.type)) return fail();
  let task: WorkTask | undefined;
  if ("taskId" in command) {
    task = tasks.find((t) => t.id === command.taskId && t.chantierId === chantier.id);
    if (!task || task.version !== command.expectedTaskVersion)
      return new WorkTaskError({ reason: "conflict" });
  }
  switch (command.type) {
    case "dossier": {
      if (
        command.stages.length &&
        !v2.framingApproved &&
        encodeDefinition(command.stages) !== encodeDefinition(v2.stages)
      )
        return fail();
      if (new Set(command.stages.map((s) => s.id)).size !== command.stages.length)
        return new WorkTaskError({ reason: "conflict" });
      if (
        command.prototype.status === "skipped" &&
        v2.prototype.status !== "skipped" &&
        actor !== "human"
      )
        return fail();
      if (
        command.prototype.status === "ready" &&
        (!command.prototype.url || !command.prototype.codeReference.trim())
      )
        return fail();
      const framingChanged =
        v2.completionCriteria !== command.completionCriteria ||
        v2.interfaceExpected !== command.interfaceExpected;
      v2 = {
        ...v2,
        completionCriteria: command.completionCriteria,
        interfaceExpected: command.interfaceExpected,
        specifications: command.specifications,
        prototype: command.prototype,
        stages: command.stages,
        framingApproved: v2.framingApproved && !framingChanged,
      };
      break;
    }
    case "memory":
      v2 = { ...v2, memory: command.memory, finalReview: command.finalReview };
      break;
    case "approveFraming":
      if (!chantier.objective.trim() || !chantier.scope.trim() || !v2.completionCriteria.trim())
        return fail();
      v2.framingApproved = true;
      status = "active";
      break;
    case "pause":
      status = "paused";
      break;
    case "stop":
      status = "paused";
      v2.stopped = true;
      break;
    case "resume":
    case "reopen":
      if (!v2.framingApproved) return fail();
      status = "active";
      v2.stopped = false;
      break;
    case "close":
      if (!v2.finalReview.trim() || tasks.some((t) => !["done", "rejected"].includes(t.status)))
        return fail();
      status = "done";
      break;
    default: {
      if (!task) return fail();
      let review = v2.reviews.find((r) => r.taskId === command.taskId) ?? {
        taskId: task.id,
        approvedDefinition: null,
        kind: "code" as const,
        pmReference: "",
        pullRequestUrl: null,
        head: null,
        humanHead: null,
        chefHead: null,
        retainedHumanApproval: "",
        mergedHead: null,
        completionEvidence: "",
        deployment: null,
      };
      switch (command.type) {
        case "approveTask":
          if (
            !v2.framingApproved ||
            status !== "active" ||
            (v2.interfaceExpected && v2.prototype.status === "pending")
          )
            return fail();
          review = {
            ...review,
            kind: command.kind,
            pmReference: command.pmReference,
            approvedDefinition: taskDefinition(task),
          };
          break;
        case "pullRequest":
          if (review.mergedHead) return fail();
          review = {
            ...review,
            pullRequestUrl: command.url,
            head: command.head,
            chefHead: review.head === command.head ? review.chefHead : null,
            retainedHumanApproval: "",
            deployment: null,
          };
          break;
        case "humanReview":
          if (!review.head) return fail();
          review = {
            ...review,
            humanHead: command.approved ? review.head : null,
            retainedHumanApproval: "",
          };
          break;
        case "chefReview":
          if (actor !== "chef" || !review.head) return fail();
          if (
            command.retainHumanApproval &&
            (!review.humanHead || !command.justification.trim() || !command.approved)
          )
            return fail();
          review = {
            ...review,
            chefHead: command.approved ? review.head : null,
            ...(command.retainHumanApproval
              ? { humanHead: review.head, retainedHumanApproval: command.justification }
              : {}),
          };
          break;
        case "merged":
          if (
            status !== "active" ||
            v2.stopped ||
            review.head !== command.head ||
            review.humanHead !== command.head ||
            review.chefHead !== command.head ||
            review.approvedDefinition !== taskDefinition(task)
          )
            return fail();
          review = { ...review, mergedHead: command.head };
          break;
        case "completeTask":
          if (
            !command.evidence.trim() ||
            review.approvedDefinition !== taskDefinition(task) ||
            (review.kind === "code" && (!review.mergedHead || review.mergedHead !== review.head))
          )
            return fail();
          review = { ...review, completionEvidence: command.evidence };
          task = { ...task, status: "done" };
          break;
        case "deploymentGo":
          if (
            status !== "active" ||
            !review.mergedHead ||
            !policy.deploymentEnvironments.includes(command.environment)
          )
            return fail();
          review = {
            ...review,
            deployment: {
              environment: command.environment,
              head: review.mergedHead,
              approved: true,
              evidence: "",
            },
          };
          break;
        case "deploymentResult":
          if (
            status !== "active" ||
            !review.deployment?.approved ||
            review.deployment.environment !== command.environment ||
            review.deployment.head !== command.head ||
            !command.evidence.trim()
          )
            return fail();
          review = {
            ...review,
            deployment: { ...review.deployment, approved: false, evidence: command.evidence },
          };
          break;
      }
      v2.reviews = [...v2.reviews.filter((r) => r.taskId !== review.taskId), review];
    }
  }
  return {
    chantier: { ...chantier, status, v2 },
    ...(command.type === "completeTask" && task ? { task } : {}),
  };
}
