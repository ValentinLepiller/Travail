import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkChantierSaveInput,
  type WorkTaskSaveInput,
  type PullRequestDetail,
} from "@t3tools/contracts";
import * as Tasks from "./WorkTaskService.ts";
import * as Coordinator from "./WorkChantierCoordinator.ts";
import * as TaskAgents from "./WorkTaskAgentService.ts";
import * as Agents from "../autonomousAgents/AutonomousAgentService.ts";
import * as Requests from "../agentRequests/AgentRequestService.ts";
import * as RequestEffects from "../agentRequests/RequestEffects.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { taskImageTestLayer } from "./WorkTaskService.testkit.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const projectId = ProjectId.make("project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const head = "a".repeat(40);
const nextHead = "b".repeat(40);
const chantier = (id = "v2"): WorkChantierSaveInput => ({
  id,
  expectedVersion: 0,
  generation: "v2",
  title: "New work",
  projectId,
  status: "draft",
  objective: "Working sales flow",
  scope: "Cashier interface only",
  decisions: "Reuse existing pricing",
  targetPeriod: "",
  sources: [],
  externalDependencies: [],
});
const task = (id = "task", chantierId = "v2"): WorkTaskSaveInput => ({
  id,
  chantierId,
  projectId,
  expectedVersion: 0,
  title: id,
  notes: "Implement the approved scope",
  acceptanceCriteria: "Sale works",
  status: "ready",
  agentThreadId: null,
  dueDate: null,
});

const fixture = Effect.gen(function* () {
  const launched: Launch.ThreadLaunchInput[] = [];
  const sent: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0][] = [];
  const interrupted: ThreadId[] = [];
  const merges: Parameters<PullRequests.PullRequestService["Service"]["runAction"]>[0][] = [];
  const remote = { head, state: "open" };
  const threads = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), projectId }),
    getThreadRecords: (() =>
      Effect.succeed({
        runs: [],
        messages: [],
      })) as Threads.ThreadManagementService["Service"]["getThreadRecords"],
    sendToThread: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return {} as Threads.ThreadManagementSendResult;
      }),
    interruptThread: (input) =>
      Effect.sync(() => {
        interrupted.push(input.threadId);
        return { type: "no_active_run" as const };
      }),
    dispatch: () => Effect.succeed({ sequence: 0, storedEvents: [] }),
  });
  const launcher = Layer.effect(
    Launch.ThreadLaunchService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Launch.ThreadLaunchService.of({
        checkWorktreeBase: () => Effect.die("unused"),
        retryPreparation: () => Effect.die("unused"),
        launch: (input) =>
          Effect.gen(function* () {
            launched.push(input);
            yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(${input.threadId!},${input.projectId},${input.title},'codex','full-access','default','now','now','{}')`;
            return {
              threadId: input.threadId!,
              resumed: false,
              projection: idleThreadProjection(liveThreadShell(input.threadId!)),
            };
          }).pipe(Effect.orDie),
      });
    }),
  );
  const db = Sqlite.layerMemory;
  const tasks = Tasks.layer.pipe(Layer.provideMerge(db), Layer.provide(taskImageTestLayer));
  const agents = Agents.layer.pipe(
    Layer.provideMerge(tasks),
    Layer.provide(threads),
    Layer.provide(launcher.pipe(Layer.provide(db))),
    Layer.provide(
      Layer.mock(Folders.ManagedProjectFolders)({
        namedProjectsRoot: "/tmp/projects",
        ensureScratchProject: Effect.succeed({ projectId }),
      }),
    ),
    Layer.provide(taskImageTestLayer),
  );
  const requests = Requests.layer.pipe(
    Layer.provideMerge(db),
    Layer.provide(
      Layer.succeed(RequestEffects.RequestEffects, {
        execute: () => Effect.succeed(true),
        notify: () => Effect.void,
      }),
    ),
  );
  const layer = Coordinator.layer.pipe(
    Layer.provideMerge(agents),
    Layer.provideMerge(requests),
    Layer.provide(threads),
    Layer.provideMerge(
      TaskAgents.layer.pipe(Layer.provide(tasks), Layer.provide(launcher.pipe(Layer.provide(db)))),
    ),
    Layer.provide(
      Layer.mock(PullRequests.PullRequestService)({
        invalidate: () => Effect.void,
        detail: () =>
          Effect.succeed({
            headSha: remote.head,
            state: remote.state,
            provider: "github",
          } as PullRequestDetail),
        runAction: (input) =>
          Effect.sync(() => {
            merges.push(input);
            remote.state = "merged";
          }),
      }),
    ),
  );
  const context = yield* Layer.build(layer);
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Project','/tmp/project','[]','now','now')`;
  }).pipe(Effect.provide(context));
  return { context, launched, sent, interrupted, merges, remote };
});

const framed = Effect.gen(function* () {
  const tasks = yield* Tasks.WorkTaskService;
  let c = yield* tasks.saveChantier(chantier());
  c = yield* tasks.commandChantierV2({
    id: c.id,
    expectedVersion: c.version,
    type: "dossier",
    completionCriteria: "A sale can be completed",
    interfaceExpected: true,
    specifications: "Use existing product APIs",
    prototype: { ...c.v2!.prototype, status: "skipped" },
    stages: [],
  });
  return yield* tasks.commandChantierV2({
    id: c.id,
    expectedVersion: c.version,
    type: "approveFraming",
  });
});

it.effect(
  "requires explicit framing, prototype choice and task approval before launching real work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.WorkTaskService;
        const c = yield* tasks.saveChantier(chantier());
        expect((yield* tasks.save(task()).pipe(Effect.flip)).reason).toBe("approval");
        expect(
          (yield* tasks
            .commandChantierV2({ id: c.id, expectedVersion: c.version, type: "approveFraming" })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        expect(
          (yield* tasks
            .applyPlan({ chantier: { ...c, expectedVersion: c.version }, tasks: [task()] })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        expect(
          (yield* tasks
            .saveChantier({ ...c, generation: "legacy", expectedVersion: c.version })
            .pipe(Effect.flip)).reason,
        ).toBe("generation");
        let current = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: c.version,
          type: "dossier",
          completionCriteria: "Sale",
          interfaceExpected: true,
          specifications: "Spec",
          prototype: c.v2!.prototype,
          stages: [],
        });
        current = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: current.version,
          type: "approveFraming",
        });
        const t = yield* tasks.save(task());
        expect(
          (yield* tasks
            .commandChantierV2({
              id: c.id,
              expectedVersion: current.version,
              type: "approveTask",
              taskId: t.id,
              expectedTaskVersion: t.version,
              kind: "code",
              pmReference: "",
            })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        current = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: current.version,
          type: "dossier",
          completionCriteria: "Sale",
          interfaceExpected: true,
          specifications: "Spec",
          prototype: {
            ...current.v2!.prototype,
            status: "ready",
            url: "http://localhost:3000",
            codeReference: "/tmp/prototype",
            annotations: [
              {
                id: "annotation",
                target: "Bouton de vente",
                text: "Confirmer après le clic",
                capture: {
                  id: "annotation",
                  pageUrl: "http://localhost:3000",
                  pageTitle: "Vente",
                  comment: "Confirmer après le clic",
                  elements: [],
                  regions: [{ id: "region", rect: { x: 1, y: 2, width: 3, height: 4 } }],
                  strokes: [],
                  styleChanges: [],
                  screenshot: null,
                  createdAt: "2026-11-10T00:00:00.000Z",
                },
              },
            ],
          },
          stages: [{ id: "first", title: "First milestone", criteria: "Sale" }],
        });
        expect((yield* tasks.assertCanStart(t).pipe(Effect.flip)).reason).toBe("approval");
        yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: current.version,
          type: "approveTask",
          taskId: t.id,
          expectedTaskVersion: t.version,
          kind: "code",
          pmReference: "PM-1",
        });
        const launched = yield* (yield* TaskAgents.WorkTaskAgentService).launch({
          id: t.id,
          expectedVersion: t.version,
          modelSelection,
        });
        expect(launched.status).toBe("doing");
        expect(f.launched[0]?.workspaceStrategy.type).toBe("worktree");
        expect(f.launched[0]?.initialMessage?.text).toContain("/tmp/prototype");
        expect((yield* tasks.readChantier(c.id)).v2?.prototype.annotations[0]?.text).toBe(
          "Confirmer après le clic",
        );
        expect(
          (yield* tasks.readChantier(c.id)).v2?.prototype.annotations[0]?.capture?.regions,
        ).toHaveLength(1);
        expect(
          (yield* tasks
            .save({ ...launched, status: "done", expectedVersion: launched.version })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
      }).pipe(Effect.provide(f.context));
    }),
);

it.effect(
  "preserves legacy orchestrator, graph, sources and behavior beside V2 and routes notifications once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.WorkTaskService;
        const coordinator = yield* Coordinator.WorkChantierCoordinator;
        const { generation: _generation, ...legacy } = chantier("legacy");
        let old = yield* tasks.applyPlan({
          chantier: {
            ...legacy,
            status: "active",
            sources: [{ kind: "meeting", label: "Existing decision", url: null }],
          },
          tasks: [task("a", "legacy"), { ...task("b", "legacy"), dependsOn: ["a"] }],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('legacy-orchestrator','project','Original orchestrator','codex','full-access','default','now','now','{}')`;
        old = yield* tasks.claimChantier(ThreadId.make("legacy-orchestrator"), {
          id: old.id,
          expectedVersion: old.version,
        });
        const originalTasks = (yield* tasks.list()).filter((t) => t.chantierId === old.id);
        const v2 = yield* framed;
        yield* tasks.save({ ...task("Manual V2 task"), automationMode: "manual" });
        yield* coordinator.launch({ id: v2.id, expectedVersion: v2.version, modelSelection });
        expect((yield* tasks.listChantiers()).map((c) => c.generation).sort()).toEqual([
          "legacy",
          "v2",
        ]);
        const notification = {
          id: old.id,
          generation: "legacy" as const,
          notificationId: "subject-1-v1",
          text: "New source information",
        };
        yield* coordinator.notify(notification);
        yield* coordinator.notify(notification);
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]?.threadId).toBe("legacy-orchestrator");
        expect(f.sent[0]?.mode).toBe("queue");
        expect(
          (yield* coordinator.notify({ ...notification, text: "Changed" }).pipe(Effect.flip))
            .reason,
        ).toBe("conflict");
        expect(
          (yield* coordinator.notify({ ...notification, generation: "v2" }).pipe(Effect.flip))
            .reason,
        ).toBe("generation");
        yield* coordinator.notify({ ...notification, id: v2.id, generation: "v2" });
        yield* coordinator.notify({ ...notification, id: v2.id, generation: "v2" });
        const agents = yield* Agents.AutonomousAgentService;
        yield* agents.tick();
        expect(f.launched).toHaveLength(1);
        const chef = (yield* agents.list()).find((a) => a.id === v2.v2!.chefAgentId)!;
        expect(chef.kind).toBe("chantier-chef");
        expect(f.launched[0]?.initialMessage?.text).toContain("New source information");
        expect(f.launched[0]?.initialMessage?.text).toContain("Manual V2 task");
        expect(
          (yield* agents.read({ id: chef.id })).chat?.filter((m) => m.role === "user"),
        ).toHaveLength(1);
        expect(yield* tasks.readChantier(old.id)).toEqual(old);
        expect((yield* tasks.list()).filter((t) => t.chantierId === old.id)).toEqual(originalTasks);
        expect((yield* tasks.assertCanStart(yield* tasks.read("b")).pipe(Effect.flip)).reason).toBe(
          "dependencies",
        );
        const a = yield* tasks.read("a");
        yield* tasks.save({ ...a, status: "done", expectedVersion: a.version });
        yield* tasks.assertCanStart(yield* tasks.read("b"));
      }).pipe(Effect.provide(f.context));
    }),
);

it.effect(
  "enforces the project-wide limit, keeps preparation on pause, requires a bilan for close and supports reopening",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.WorkTaskService;
        let c = yield* framed;
        const a = yield* tasks.save(task("a"));
        const b = yield* tasks.save(task("b"));
        for (const t of [a, b])
          c = yield* tasks.commandChantierV2({
            id: c.id,
            expectedVersion: c.version,
            type: "approveTask",
            taskId: t.id,
            expectedTaskVersion: t.version,
            kind: "other",
            pmReference: "PM-1",
          });
        const doing = yield* tasks.save({ ...a, status: "doing", expectedVersion: a.version });
        expect((yield* tasks.assertCanStart(b).pipe(Effect.flip)).reason).toBe("parallelism");
        c = yield* tasks.commandChantierV2({ id: c.id, expectedVersion: c.version, type: "pause" });
        expect((yield* tasks.assertCanStart(b).pipe(Effect.flip)).reason).toBe("approval");
        yield* tasks.save({ ...doing, status: "review", expectedVersion: doing.version });
        expect(
          (yield* tasks
            .commandChantierV2({ id: c.id, expectedVersion: c.version, type: "close" })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        c = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: c.version,
          type: "resume",
        });
        for (const t of [yield* tasks.read("a"), b])
          c = yield* tasks.commandChantierV2({
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "completeTask",
            evidence: "Acceptance scenario passed",
          });
        c = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: c.version,
          type: "memory",
          memory: "Finished",
          finalReview: "All acceptance criteria satisfied",
        });
        c = yield* tasks.commandChantierV2({ id: c.id, expectedVersion: c.version, type: "close" });
        expect(c.status).toBe("done");
        c = yield* tasks.commandChantierV2({
          id: c.id,
          expectedVersion: c.version,
          type: "reopen",
        });
        expect(c.status).toBe("active");
        expect(c.v2?.memory).toBe("Finished");
      }).pipe(Effect.provide(f.context));
    }),
);

it.effect(
  "binds human approval to Requêtes, reviews the latest code, merges after two accords and separates deployment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.WorkTaskService;
        const coordinator = yield* Coordinator.WorkChantierCoordinator;
        const agents = yield* Agents.AutonomousAgentService;
        let c = yield* framed;
        yield* coordinator.launch({ id: c.id, expectedVersion: c.version, modelSelection });
        yield* agents.tick();
        const chef = (yield* agents.list()).find((a) => a.id === c.v2!.chefAgentId)!;
        const caller = chef.currentThreadId!;
        let t = yield* tasks.save(task());
        const approve = {
          id: c.id,
          expectedVersion: c.version,
          type: "approveTask" as const,
          taskId: t.id,
          expectedTaskVersion: t.version,
          kind: "code" as const,
          pmReference: "PM-1",
        };
        expect((yield* coordinator.command(approve, caller).pipe(Effect.flip)).reason).toBe(
          "approval",
        );
        const request = yield* coordinator.requestApproval(
          { requestId: "task-approval", command: approve },
          caller,
        );
        expect(
          (yield* coordinator
            .command({ ...approve, approvalRequestId: request.id }, caller)
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        yield* (yield* Requests.AgentRequestService).respond({
          id: request.id,
          expectedVersion: request.version,
          decision: "accept",
          text: "",
        });
        c = yield* coordinator.command({ ...approve, approvalRequestId: request.id }, caller);
        c = yield* coordinator.command(
          {
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "pullRequest",
            url: "https://github.com/example/project/pull/1",
            head,
          },
          caller,
        );
        c = yield* coordinator.command({
          id: c.id,
          expectedVersion: c.version,
          taskId: t.id,
          expectedTaskVersion: t.version,
          type: "humanReview",
          approved: true,
        });
        expect(f.merges).toHaveLength(0);
        f.remote.head = nextHead;
        expect(
          (yield* coordinator
            .command(
              {
                id: c.id,
                expectedVersion: c.version,
                taskId: t.id,
                expectedTaskVersion: t.version,
                type: "chefReview",
                approved: true,
                retainHumanApproval: false,
                justification: "",
              },
              caller,
            )
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        c = yield* coordinator.command(
          {
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "pullRequest",
            url: "https://github.com/example/project/pull/1",
            head: nextHead,
          },
          caller,
        );
        c = yield* coordinator.command(
          {
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "chefReview",
            approved: true,
            retainHumanApproval: false,
            justification: "Impact requires human review",
          },
          caller,
        );
        expect(f.merges).toHaveLength(0);
        c = yield* coordinator.command({
          id: c.id,
          expectedVersion: c.version,
          taskId: t.id,
          expectedTaskVersion: t.version,
          type: "humanReview",
          approved: true,
        });
        expect(f.merges).toHaveLength(1);
        expect(f.merges[0]?.expectedHeadSha).toBe(nextHead);
        expect(c.v2?.reviews[0]?.mergedHead).toBe(nextHead);
        expect((yield* tasks.read(t.id)).status).toBe("ready");
        c = yield* coordinator.command(
          {
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "completeTask",
            evidence: "Merged PR and acceptance passed",
          },
          caller,
        );
        t = yield* tasks.read(t.id);
        expect(t.status).toBe("done");
        expect(c.v2?.reviews[0]?.deployment).toBeNull();
        expect(
          (yield* coordinator
            .command({
              id: c.id,
              expectedVersion: c.version,
              taskId: t.id,
              expectedTaskVersion: t.version,
              type: "deploymentGo",
              environment: "production",
            })
            .pipe(Effect.flip)).reason,
        ).toBe("approval");
        const policy = yield* tasks.chantierPolicy(projectId);
        yield* tasks.saveChantierPolicy({ ...policy, deploymentEnvironments: ["staging"] });
        c = yield* coordinator.command({
          id: c.id,
          expectedVersion: c.version,
          taskId: t.id,
          expectedTaskVersion: t.version,
          type: "deploymentGo",
          environment: "staging",
        });
        c = yield* coordinator.command(
          {
            id: c.id,
            expectedVersion: c.version,
            taskId: t.id,
            expectedTaskVersion: t.version,
            type: "deploymentResult",
            environment: "staging",
            head: nextHead,
            evidence: "Health check passed",
          },
          caller,
        );
        expect(c.v2?.reviews[0]?.deployment?.approved).toBe(false);
      }).pipe(Effect.provide(f.context));
    }),
);

it.effect("only sends Inbox messages present at each human click, once per destination", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.WorkChantierCoordinator;
      const c = yield* framed;
      yield* coordinator.launch({ id: c.id, expectedVersion: c.version, modelSelection });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at) VALUES('subject','New information','A source needs attention','now')`;
      for (const id of ["entry-1", "entry-2"]) {
        yield* sql`INSERT INTO message_inbox(id,payload_json) VALUES(${id},'{}')`;
        yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES(${id},'subject','now','{}')`;
      }
      const notification = {
        id: c.id,
        generation: "v2" as const,
        subjectId: "subject",
        expectedEntries: 2,
      };
      yield* coordinator.notifySubject(notification);
      yield* coordinator.notifySubject(notification);
      const agents = yield* Agents.AutonomousAgentService;
      expect((yield* agents.read({ id: c.v2!.chefAgentId })).chat).toHaveLength(1);
      yield* sql`INSERT INTO message_inbox(id,payload_json) VALUES('entry-3','{}')`;
      yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES('entry-3','subject','now','{}')`;
      expect((yield* agents.read({ id: c.v2!.chefAgentId })).chat).toHaveLength(1);
      expect((yield* coordinator.notifySubject(notification).pipe(Effect.flip)).reason).toBe(
        "conflict",
      );
      yield* coordinator.notifySubject({ ...notification, expectedEntries: 3 });
      const chat = (yield* agents.read({ id: c.v2!.chefAgentId })).chat!;
      expect(chat).toHaveLength(2);
      expect(chat[1]?.text).toContain("entry-3");
      expect(chat[1]?.text).not.toContain("entry-1");
    }).pipe(Effect.provide(f.context));
  }),
);

it.effect("pause lets owned agents finish preparation; stop interrupts only this chantier", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const tasks = yield* Tasks.WorkTaskService;
      const coordinator = yield* Coordinator.WorkChantierCoordinator;
      const agents = yield* Agents.AutonomousAgentService;
      let c = yield* framed;
      yield* coordinator.launch({ id: c.id, expectedVersion: c.version, modelSelection });
      yield* agents.tick();
      const chef = (yield* agents.list()).find((a) => a.id === c.v2!.chefAgentId)!;
      const a = yield* tasks.save(task());
      c = yield* tasks.commandChantierV2({
        id: c.id,
        expectedVersion: c.version,
        type: "approveTask",
        taskId: a.id,
        expectedTaskVersion: a.version,
        kind: "code",
        pmReference: "",
      });
      const running = yield* (yield* TaskAgents.WorkTaskAgentService).launch(
        { id: a.id, expectedVersion: a.version, modelSelection },
        chef.currentThreadId!,
      );
      c = yield* coordinator.command({ id: c.id, expectedVersion: c.version, type: "pause" });
      expect(f.interrupted).toHaveLength(0);
      yield* tasks.save(
        { ...running, status: "review", expectedVersion: running.version },
        running.agentThreadId!,
      );
      c = yield* coordinator.command(
        {
          id: c.id,
          expectedVersion: c.version,
          type: "memory",
          memory: "Preparation saved while paused",
          finalReview: "",
        },
        chef.currentThreadId!,
      );
      yield* agents.finish(
        chef.currentThreadId!,
        "Prepared, waiting for human",
        "Preparation finished",
      );
      expect((yield* tasks.assertCanStart(yield* tasks.read(a.id)).pipe(Effect.flip)).reason).toBe(
        "approval",
      );
      c = yield* coordinator.command({ id: c.id, expectedVersion: c.version, type: "stop" });
      expect(f.interrupted).toEqual([chef.currentThreadId, running.agentThreadId]);
      expect(c.v2?.stopped).toBe(true);
      const launchesBeforeSettling = f.launched.length;
      yield* agents.tick();
      const sleeping = (yield* agents.list()).find((a) => a.id === chef.id)!;
      expect(sleeping.currentThreadId).toBeNull();
      expect(sleeping.paused).toBe(true);
      expect(sleeping.status).toBe("paused");
      expect(f.launched).toHaveLength(launchesBeforeSettling);
      const old = yield* tasks.saveChantier({
        ...chantier("old"),
        generation: "legacy",
        status: "active",
      });
      expect(
        (yield* tasks
          .saveChantier(
            { ...old, scope: "Forbidden", expectedVersion: old.version },
            chef.currentThreadId!,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      const other = yield* tasks.save({ ...task("outside"), chantierId: null });
      expect(
        (yield* tasks
          .save(
            { ...other, title: "Forbidden", expectedVersion: other.version },
            chef.currentThreadId!,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
    }).pipe(Effect.provide(f.context));
  }),
);
