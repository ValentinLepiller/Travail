import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AutonomousAgentConfig, ThreadId, ProjectId } from "@t3tools/contracts";
import * as Agents from "./AutonomousAgentService.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "../workTasks/WorkTaskService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const decodeConfig = Schema.decodeUnknownSync(AutonomousAgentConfig);
const agentConfig = (id = "qualifier", trigger = "interval") =>
  decodeConfig({
    id,
    name: id,
    mission: "Qualifier les tâches de Valentin",
    projectId: trigger === "unqualified" ? null : "test-project",
    modelSelection: { instanceId: "codex", model: "gpt-test" },
    intervalSeconds: 60,
    trigger,
    x: 40,
    y: 40,
  });
const fixture = Effect.gen(function* () {
  const launched: ThreadId[] = [];
  const launchInputs: Launch.ThreadLaunchInput[] = [];
  const sentProjects: ProjectId[] = [];
  const sent: { threadId: ThreadId; text: string }[] = [];
  const archived: ThreadId[] = [];
  const snoozed: ThreadId[] = [];
  const awakened: ThreadId[] = [];
  let interrupted = 0;
  const threadsLayer = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed({
        ...liveThreadShell(id),
        projectId:
          launchInputs.find((input) => input.threadId === id)?.projectId ??
          ProjectId.make("test-project"),
      }),
    getThreadRecords: (() =>
      Effect.succeed({
        runs: [],
        messages: [],
      })) as Threads.ThreadManagementService["Service"]["getThreadRecords"],
    sendToThread: (input) =>
      Effect.sync(() => {
        sent.push(input);
        sentProjects.push(input.projectId);
        return {} as Threads.ThreadManagementSendResult;
      }),
    interruptThread: () =>
      Effect.sync(() => {
        interrupted++;
        return { type: "no_active_run" as const };
      }),
    dispatch: (input) =>
      Effect.sync(() => {
        if (input.type === "thread.archive") archived.push(input.threadId);
        if (input.type === "thread.snooze") snoozed.push(input.threadId);
        if (input.type === "thread.unsnooze") awakened.push(input.threadId);
        return { sequence: 0, storedEvents: [] };
      }),
  });
  const launchLayer = Layer.mock(Launch.ThreadLaunchService)({
    launch: (input) =>
      Effect.sync(() => {
        const threadId = input.threadId!;
        launched.push(threadId);
        launchInputs.push(input);
        return {
          threadId,
          resumed: false,
          projection: idleThreadProjection(liveThreadShell(threadId)),
        };
      }),
  });
  const db = Sqlite.layerMemory;
  const layer = Agents.layer.pipe(
    Layer.provideMerge(db),
    Layer.provideMerge(Tasks.layer.pipe(Layer.provide(db))),
    Layer.provide(threadsLayer),
    Layer.provide(launchLayer),
    Layer.provide(
      Layer.mock(ManagedFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/tmp/autonomous-test-projects",
        ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
      }),
    ),
    Layer.provide(Config.layerTest(process.cwd(), { prefix: "autonomous-test-" })),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  return {
    context,
    launched,
    launchInputs,
    sentProjects,
    sent,
    archived,
    snoozed,
    awakened,
    interrupts: () => interrupted,
  };
});

it.effect("restores repository agents on a fresh environment without starting work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      yield* Agents.initializeConfiguredAgents;
      const service = yield* Agents.AutonomousAgentService;
      const agents = yield* service.list();
      expect(agents.map((agent) => agent.id)).toEqual([
        "coordinateur-taches",
        "qualifieur",
        "slack-exclusions-review",
      ]);
      expect(agents.every((agent) => agent.paused && agent.currentThreadId === null)).toBe(true);
      expect(agents.every((agent) => agent.projectId === null)).toBe(true);
      yield* service.tick();
      expect(f.launched).toHaveLength(0);
      expect((yield* service.read({ id: "coordinateur-taches" })).memory).toBe("");
      expect(agents.find((agent) => agent.id === "slack-exclusions-review")?.dailySchedule).toEqual(
        { timeOfDay: "09:00", timeZone: "Europe/Paris" },
      );
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("restoring repository agents preserves local configuration, memory and active runs", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = { ...agentConfig("coordinateur-taches"), mission: "Mission locale" };
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "memory", id: config.id, memory: "Mémoire locale" });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      const before = (yield* service.list()).find((agent) => agent.id === config.id);
      yield* Agents.initializeConfiguredAgents;
      yield* Agents.initializeConfiguredAgents;
      expect((yield* service.list()).find((agent) => agent.id === config.id)).toEqual(before);
      expect((yield* service.read({ id: config.id })).memory).toBe("Mémoire locale");
      expect(yield* service.list()).toHaveLength(3);
      expect(f.launched).toHaveLength(1);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("starts paused and concurrent scheduler ticks launch exactly one durable thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      yield* agents.command({ type: "save", config: agentConfig() });
      yield* agents.tick();
      expect(f.launched).toHaveLength(0);
      yield* agents.command({ type: "resume", id: "qualifier" });
      yield* Effect.all([agents.tick(), agents.tick()], { concurrency: "unbounded" });
      expect(f.launched).toHaveLength(1);
      expect((yield* agents.list())[0]?.currentThreadId).toBe(f.launched[0]);
      expect(f.archived).toHaveLength(0);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("pause stops the current work and resume uses the same thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      yield* agents.command({ type: "save", config: agentConfig() });
      yield* agents.command({ type: "resume", id: "qualifier" });
      yield* agents.tick();
      yield* agents.command({ type: "pause", id: "qualifier" });
      yield* agents.tick();
      expect(f.interrupts()).toBe(1);
      expect((yield* agents.list())[0]?.paused).toBe(true);
      yield* agents.command({ type: "resume", id: "qualifier" });
      expect(f.launched).toHaveLength(1);
      expect(f.sent[0]?.threadId).toBe(f.launched[0]);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect(
  "persists memory before archiving and keeps the archived transcript in agent history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AutonomousAgentService;
        yield* agents.command({ type: "save", config: agentConfig() });
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        yield* agents.finish(f.launched[0]!, "RGC : uniquement la caisse.", "Qualifié");
        expect((yield* agents.read({ id: "qualifier" })).memory).toBe(
          "RGC : uniquement la caisse.",
        );
        expect(f.archived).toHaveLength(0);
        yield* agents.tick();
        expect(f.archived).toEqual(f.launched);
        expect((yield* agents.list())[0]?.currentThreadId).toBeNull();
        expect(
          (yield* agents.read({ id: "qualifier", threadId: f.launched[0]! })).history[0]
            ?.finishedAt,
        ).not.toBeNull();
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect(
  "snoozes provisional qualification and wakes that thread before ordinary work after the response",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AutonomousAgentService;
        const sql = yield* SqlClient.SqlClient;
        yield* agents.command({ type: "save", config: agentConfig() });
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        const threadId = f.launched[0]!;
        yield* sql`INSERT INTO agent_requests (id,payload_json) VALUES ('decision', ${`{"threadId":"${threadId}","status":"pending","delivery":"none"}`})`;
        yield* agents.finish(threadId, "En attente de décision", "Qualification provisoire");
        yield* agents.tick();
        expect(f.archived).not.toContain(threadId);
        expect(f.snoozed).toContain(threadId);
        expect((yield* agents.read({ id: "qualifier" })).history[0]?.waitingFor).toBe("human");
        yield* sql`DELETE FROM agent_requests`;
        yield* agents.command({ type: "pause", id: "qualifier" });
        yield* agents.enqueueDecision(threadId, "decision:2", "Ne refuse pas cette tâche.");
        yield* agents.tick();
        expect(f.sent).toHaveLength(0);
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        expect(f.sent[0]?.threadId).toBe(threadId);
        expect(f.sent[0]?.text).toContain("Ne refuse pas");
        expect(f.launched).toHaveLength(1);
        yield* agents.finish(threadId, "Règle corrigée après arbitrage", "Appris");
        yield* agents.tick();
        yield* agents.enqueueDecision(threadId, "decision:2", "Ne refuse pas cette tâche.");
        yield* agents.tick();
        expect(f.sent).toHaveLength(1);
        expect((yield* agents.list())[0]?.currentThreadId).toBeNull();
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect("serves queued agent questions before ordinary tasks and prevents circular waits", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      yield* agents.command({ type: "save", config: agentConfig("a") });
      yield* agents.command({ type: "save", config: agentConfig("b", "unqualified") });
      yield* agents.command({ type: "resume", id: "a" });
      yield* agents.command({ type: "resume", id: "b" });
      yield* agents.tick();
      const a = (yield* agents.list()).find((x) => x.id === "a")!;
      yield* agents.ask(a.currentThreadId!, "b", "Quel est le périmètre ?");
      yield* agents.finish(a.currentThreadId!, "Attend la réponse de b", "En attente");
      // Agent messages are serviced even if the ordinary condition was recently false.
      yield* agents.tick();
      expect(f.snoozed).toContain(a.currentThreadId);
      expect((yield* agents.read({ id: "a" })).history[0]?.waitingFor).toBe("agent");
      const b = (yield* agents.list()).find((x) => x.id === "b")!;
      expect(b.currentThreadId).not.toBeNull();
      expect(
        (yield* agents.ask(b.currentThreadId!, "a", "Question circulaire").pipe(Effect.flip))
          .message,
      ).toContain("circulaire");
      yield* agents.finish(b.currentThreadId!, "Périmètre appris", "La caisse uniquement.");
      yield* agents.tick();
      yield* agents.tick();
      expect(
        f.sent.some(
          (x) => x.threadId === a.currentThreadId && x.text.includes("La caisse uniquement"),
        ),
      ).toBe(true);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect(
  "does not requalify a task awaiting a human decision and continues with the next task",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AutonomousAgentService;
        const tasks = yield* Tasks.WorkTaskService;
        const sql = yield* SqlClient.SqlClient;
        const fields = {
          title: "Demande à arbitrer",
          notes: "",
          status: "unqualified" as const,
          projectId: null,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        };
        yield* tasks.save({ ...fields, id: "task-1" });
        yield* agents.command({ type: "save", config: agentConfig("qualifier", "unqualified") });
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        const threadId = f.launched[0]!;
        yield* sql`INSERT INTO agent_requests (id,payload_json) VALUES ('decision', ${`{"threadId":"${threadId}","status":"pending","delivery":"none"}`})`;
        yield* agents.finish(threadId, "Attente d’arbitrage", "Provisoire");
        yield* agents.tick();
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        expect(f.launched).toHaveLength(1);
        yield* tasks.save({ ...fields, id: "task-2", title: "Autre demande" });
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        expect(f.launched).toHaveLength(2);
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect(
  "queues a human response behind the active thread and wakes it before ordinary work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AutonomousAgentService;
        const sql = yield* SqlClient.SqlClient;
        yield* agents.command({ type: "save", config: agentConfig() });
        yield* agents.command({
          type: "memory",
          id: "qualifier",
          memory: "## Personnalité\nPatient et direct.\n\n## Connaissances\nAvant",
        });
        yield* agents.command({ type: "resume", id: "qualifier" });
        yield* agents.tick();
        const waiting = f.launched[0]!;
        yield* sql`INSERT INTO agent_requests (id,payload_json) VALUES ('decision', ${`{"threadId":"${waiting}","status":"pending","delivery":"none"}`})`;
        yield* agents.finish(waiting, "## Connaissances\nDoute à arbitrer", "Provisoire");
        yield* agents.tick();
        yield* agents.tick();
        const current = f.launched[1]!;
        expect(current).toBeDefined();
        yield* sql`DELETE FROM agent_requests`;
        yield* agents.enqueueDecision(waiting, "decision:2", "Garder la tâche");
        yield* agents.tick();
        expect(f.sent).toHaveLength(0);
        expect((yield* agents.list())[0]?.currentThreadId).toBe(current);
        yield* agents.finish(current, "## Connaissances\nAutre tâche terminée", "Fini");
        yield* agents.tick();
        yield* agents.tick();
        expect(f.sent[0]?.threadId).toBe(waiting);
        expect(f.sent[0]?.text).toContain("Autre tâche terminée");
        expect(f.sent[0]?.text).toContain("Patient et direct.");
        expect(f.launched).toHaveLength(2);
        expect(
          (yield* agents.read({ id: "qualifier", threadId: waiting })).history.find(
            (r) => r.threadId === waiting,
          )?.waitingFor,
        ).toBeNull();
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect("qualifies every project's tasks and unassigned tasks from a neutral workspace", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const tasks = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-30T12:00:00Z";
      for (const id of ["project-a", "project-b"])
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},${`/tmp/${id}`},'[]',${now},${now})`;
      for (const [id, projectId] of [
        ["task-a", ProjectId.make("project-a")],
        ["task-b", ProjectId.make("project-b")],
        ["task-unknown", null],
      ] as const) {
        yield* tasks.save({
          id,
          title: id,
          notes: "",
          status: "unqualified",
          projectId,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
      }
      yield* agents.command({
        type: "save",
        config: agentConfig("global-qualifier", "unqualified"),
      });
      expect((yield* agents.list())[0]?.projectId).toBeNull();
      const processed = new Set<string>();
      for (let i = 0; i < 3; i++) {
        yield* agents.command({ type: "resume", id: "global-qualifier" });
        yield* agents.tick();
        const active = (yield* agents.list())[0]!.currentThreadId!;
        const run = (yield* sql<{
          task_id: string;
        }>`SELECT task_id FROM autonomous_agent_runs WHERE thread_id = ${active}`)[0]!;
        processed.add(run.task_id);
        const task = (yield* tasks.list()).find((t) => t.id === run.task_id)!;
        if (i === 0) {
          yield* agents.command({ type: "pause", id: "global-qualifier" });
          yield* agents.command({ type: "resume", id: "global-qualifier" });
          expect(f.sentProjects[0]).toBe("scratch");
        }
        yield* tasks.save({ ...task, status: "todo", expectedVersion: task.version });
        yield* agents.finish(active, `Projet de ${task.id} identifié`, "Qualifié");
        yield* agents.tick();
      }
      expect(processed).toEqual(new Set(["task-a", "task-b", "task-unknown"]));
      expect(f.launchInputs).toHaveLength(3);
      expect(f.launchInputs.every((input) => input.projectId === "scratch")).toBe(true);
      expect(f.launchInputs[0]?.initialMessage?.text).toContain(
        "tous les projets de cette machine",
      );
      expect(f.launchInputs[0]?.initialMessage?.text).toContain("t3_project_list");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("keeps a project-scoped qualifier inside its selected project", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const tasks = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-30T12:00:00Z";
      for (const id of ["project-a", "project-b"]) {
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},${`/tmp/${id}`},'[]',${now},${now})`;
        yield* tasks.save({
          id,
          title: id,
          notes: "",
          status: "unqualified",
          projectId: ProjectId.make(id),
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
      }
      yield* agents.command({
        type: "save",
        config: { ...agentConfig("local", "unqualified"), projectId: ProjectId.make("project-a") },
      });
      yield* agents.command({ type: "resume", id: "local" });
      yield* agents.tick();
      expect(f.launchInputs[0]?.projectId).toBe("project-a");
      expect(f.launchInputs[0]?.initialMessage?.text).toContain("Tâche project-a");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("resumes interrupted work when a decision belongs to another thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      yield* agents.command({ type: "save", config: agentConfig() });
      yield* agents.command({ type: "resume", id: "qualifier" });
      yield* agents.tick();
      const first = f.launched[0]!;
      yield* agents.finish(first, "Mémoire", "Terminé");
      yield* agents.tick();
      yield* agents.command({ type: "resume", id: "qualifier" });
      yield* agents.tick();
      const current = f.launched[1]!;
      expect(current).toBeDefined();
      yield* agents.enqueueDecision(first, "old-decision", "Décision pour le premier thread");
      yield* agents.tick();
      expect((yield* agents.list())[0]?.status).toBe("blocked");
      yield* agents.command({ type: "resume", id: "qualifier" });
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]?.threadId).toBe(current);
      expect((yield* agents.list())[0]?.status).toBe("working");
      yield* agents.finish(current, "Mémoire mise à jour", "Terminé");
      yield* agents.tick();
      yield* agents.tick();
      expect(f.sent[1]?.threadId).toBe(first);
      expect(f.sent[1]?.text).toContain("Décision pour le premier thread");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("prepares only available todo tasks and prevents duplicate coordinator launches", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const tasks = yield* Tasks.WorkTaskService;
      for (const id of ["coordinator-a", "coordinator-b"]) {
        yield* agents.command({
          type: "save",
          config: { ...agentConfig(id, "todo"), projectId: null },
        });
        yield* agents.command({ type: "resume", id });
      }
      for (const status of ["unqualified", "ready", "doing", "done"] as const) {
        yield* tasks.save({
          id: status,
          title: status,
          notes: "",
          status,
          projectId: null,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
      }
      yield* agents.tick();
      expect(f.launched).toHaveLength(0);
      yield* tasks.save({
        id: "to-prepare",
        title: "Préparer la demande",
        notes: "Contexte utile",
        status: "todo",
        projectId: null,
        agentThreadId: null,
        dueDate: null,
        expectedVersion: 0,
      });
      // Resume clears the existing eligibility check deadline.
      for (const id of ["coordinator-a", "coordinator-b"]) {
        yield* agents.command({ type: "resume", id });
      }
      yield* Effect.all([agents.tick(), agents.tick()], { concurrency: "unbounded" });
      expect(f.launched).toHaveLength(1);
      expect(f.launchInputs[0]?.initialMessage?.text).toContain("Tâche to-prepare");
      expect(f.launchInputs[0]?.initialMessage?.text).toContain("Contexte utile");
      expect(f.launchInputs[0]?.projectId).toBe("scratch");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("daily agents retain a visible run and wait until the next local morning", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const config = {
        ...agentConfig(),
        dailySchedule: { timeOfDay: "09:00", timeZone: "Europe/Paris" },
      };
      yield* agents.command({ type: "save", config });
      yield* agents.command({ type: "resume", id: config.id });
      yield* agents.tick();
      yield* agents.finish(f.launched[0]!, "Audit effectué, filtres préservés", "Terminé");
      yield* agents.tick();
      const next = (yield* agents.list())[0]!.nextRunAt;
      expect(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Paris",
          hour: "2-digit",
          minute: "2-digit",
        }).format(next),
      ).toBe("09:00");
      yield* agents.tick();
      expect(f.launched).toHaveLength(1);
      expect((yield* agents.read({ id: config.id })).history).toHaveLength(1);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);
