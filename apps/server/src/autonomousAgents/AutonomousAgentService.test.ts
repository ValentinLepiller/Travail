import * as InboxActions from "../inbox/InboxSubjectActions.ts";
import { taskImageTestLayer } from "../workTasks/WorkTaskService.testkit.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
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
  const missingShells = new Set<ThreadId>();
  const shells = new Map<ThreadId, Partial<ReturnType<typeof liveThreadShell>>>();
  const launchInputs: Launch.ThreadLaunchInput[] = [];
  const sentProjects: ProjectId[] = [];
  const sent: { threadId: ThreadId; text: string }[] = [];
  const archived: ThreadId[] = [];
  const snoozed: ThreadId[] = [];
  const awakened: ThreadId[] = [];
  let interrupted = 0;
  const threadsLayer = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        missingShells.has(id)
          ? null
          : {
              ...liveThreadShell(id),
              projectId:
                launchInputs.find((input) => input.threadId === id)?.projectId ??
                ProjectId.make("test-project"),
              ...shells.get(id),
            },
      ),
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
    Layer.provideMerge(Tasks.layer.pipe(Layer.provide(taskImageTestLayer)).pipe(Layer.provide(db))),
    Layer.provide(threadsLayer),
    Layer.provide(launchLayer),
    Layer.provide(
      Layer.mock(ManagedFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/tmp/autonomous-test-projects",
        ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
      }),
    ),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "autonomous-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.build(layer);
  return {
    context,
    missingShells,
    shells,
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
      expect(agents.map((agent) => agent.id)).toEqual(["chef-travail", "slack-exclusions-review"]);
      expect(agents.every((agent) => agent.paused && agent.currentThreadId === null)).toBe(true);
      expect(agents.every((agent) => agent.projectId === null)).toBe(true);
      yield* service.tick();
      expect(f.launched).toHaveLength(0);
      expect((yield* service.read({ id: "slack-exclusions-review" })).memory).toBe("");
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

it.effect("changes the model for future launches while preserving an unfinished discussion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const config = agentConfig();
      yield* agents.command({ type: "save", config });
      yield* agents.command({ type: "resume", id: config.id });
      yield* agents.tick();
      const threadId = f.launched[0]!;
      const updated = decodeConfig({
        ...config,
        modelSelection: {
          instanceId: "codex",
          model: "gpt-6.1-terra",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* agents.command({ type: "save", config: updated });
      expect((yield* agents.list())[0]?.modelSelection).toEqual(updated.modelSelection);
      expect((yield* agents.list())[0]?.currentThreadId).toBe(threadId);
      expect(f.launchInputs[0]?.modelSelection).toEqual(config.modelSelection);
      expect(f.interrupts()).toBe(0);
      const changedProject = yield* agents
        .command({ type: "save", config: { ...updated, projectId: ProjectId.make("other") } })
        .pipe(Effect.flip);
      expect(changedProject.message).toContain("projet ou de fournisseur");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("replays a reserved launch whose thread was never created", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      yield* agents.command({ type: "save", config: agentConfig() });
      yield* agents.command({ type: "resume", id: "qualifier" });
      yield* agents.tick();
      const reserved = f.launched[0]!;
      f.missingShells.add(reserved);
      yield* agents.command({ type: "resume", id: "qualifier" });
      expect(f.launched).toEqual([reserved, reserved]);
      expect(f.launchInputs[1]?.reuseExistingThread).not.toBe(true);
      expect(f.launchInputs[1]?.commandId).toBe(f.launchInputs[0]?.commandId);
      expect((yield* agents.read({ id: "qualifier" })).history).toHaveLength(1);
      expect((yield* agents.list())[0]?.currentThreadId).toBe(reserved);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("archives a paused agent without losing history and restores it paused", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const agents = yield* Agents.AutonomousAgentService;
      const config = agentConfig("qualifieur");
      yield* agents.command({ type: "save", config });
      yield* agents.command({ type: "resume", id: config.id });
      yield* agents.tick();
      expect(
        (yield* agents.command({ type: "archive", id: config.id }).pipe(Effect.flip)).message,
      ).toContain("pause");
      yield* agents.finish(f.launched[0]!, "Décisions conservées", "Terminé");
      yield* agents.tick();
      yield* agents.command({ type: "pause", id: config.id });
      yield* agents.command({ type: "archive", id: config.id });
      expect(yield* agents.list()).toEqual([]);
      expect(yield* agents.subscribe().pipe(Stream.take(1), Stream.runCollect)).toEqual([[]]);
      expect((yield* agents.read({ id: config.id })).history).toHaveLength(1);
      expect((yield* agents.read({ id: config.id })).memory).toBe("Décisions conservées");
      yield* Agents.initializeConfiguredAgents;
      expect((yield* agents.list()).some((agent) => agent.id === config.id)).toBe(false);
      expect((yield* agents.list(true)).find((agent) => agent.id === config.id)?.mission).toBe(
        config.mission,
      );
      expect(
        (yield* agents.command({ type: "resume", id: config.id }).pipe(Effect.flip)).message,
      ).toContain("Restaure");
      yield* agents.command({ type: "unarchive", id: config.id });
      const restored = (yield* agents.list()).find((agent) => agent.id === config.id)!;
      expect(restored.paused).toBe(true);
      expect(restored.archived).toBe(false);
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
      const sql = yield* SqlClient.SqlClient;
      yield* agents.command({ type: "save", config: agentConfig("a") });
      yield* agents.command({ type: "save", config: agentConfig("b") });
      yield* agents.command({ type: "resume", id: "a" });
      yield* agents.command({ type: "resume", id: "b" });
      yield* sql`UPDATE autonomous_agents SET payload_json=json_set(payload_json,'$.nextRunAt',9000000000000) WHERE id='b'`;
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

const chefConfig = () =>
  decodeConfig({ ...agentConfig("chef"), kind: "chef", intervalSeconds: 900 });

it.effect("requires one project per Chef and preserves paused messages until start", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = chefConfig();
      yield* service.command({ type: "save", config: { ...config, projectId: null } });
      expect(
        (yield* service.command({ type: "resume", id: config.id }).pipe(Effect.flip)).message,
      ).toContain("projet");
      yield* service.command({
        type: "message",
        id: config.id,
        messageId: "first",
        text: "Prends les urgences en premier",
      });
      yield* service.command({
        type: "message",
        id: config.id,
        messageId: "first",
        text: "Prends les urgences en premier",
      });
      yield* service.tick();
      expect(f.launched).toHaveLength(0);
      expect((yield* service.read({ id: config.id })).chat).toHaveLength(1);
      yield* service.command({ type: "save", config });
      expect(
        (yield* service
          .command({ type: "save", config: { ...config, id: "duplicate" } })
          .pipe(Effect.flip)).message,
      ).toContain("déjà un Chef");
      yield* service.command({ type: "resume", id: config.id });
      yield* Effect.all([service.tick(), service.tick()], { concurrency: "unbounded" });
      expect(f.launched).toHaveLength(1);
      expect(f.launchInputs[0]?.initialMessage?.text).toContain("Prends les urgences en premier");
      expect(f.launchInputs[0]?.projectId).toBe(config.projectId);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect(
  "queues a human message once in the current Chef pass and resets its completion marker",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Agents.AutonomousAgentService;
        const sql = yield* SqlClient.SqlClient;
        const config = chefConfig();
        yield* service.command({ type: "save", config });
        yield* service.command({ type: "resume", id: config.id });
        yield* service.tick();
        const threadId = f.launched[0]!;
        yield* service.finish(threadId, "Mémoire", "Passage fini");
        yield* service.command({
          type: "message",
          id: config.id,
          messageId: "steer",
          text: "Et le déploiement ?",
        });
        yield* service.tick();
        expect(f.sent).toHaveLength(1);
        expect(f.sent[0]?.threadId).toBe(threadId);
        expect(f.sent[0]?.text).toContain("Et le déploiement ?");
        expect(
          (yield* sql<{
            completed: number;
          }>`SELECT completed FROM autonomous_agent_runs WHERE thread_id = ${threadId}`)[0]
            ?.completed,
        ).toBe(0);
        yield* service.tick();
        expect(f.sent).toHaveLength(1);
        expect(f.archived).toHaveLength(0);
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect(
  "persists Chef replies and self-edited rules without widening scope or overriding pause",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Agents.AutonomousAgentService;
        const config = chefConfig();
        yield* service.command({ type: "save", config });
        yield* service.command({ type: "resume", id: config.id });
        yield* service.tick();
        const threadId = f.launched[0]!;
        yield* service.chefMessage(threadId, "answer", "Je garde une tâche en cours.");
        yield* service.chefMessage(threadId, "answer", "Je garde une tâche en cours.");
        yield* service.chefRules(threadId, {
          mission: "Vérifie les PR une fois par heure",
          intervalSeconds: 3600,
          wakeOnTaskChanges: false,
        });
        const agent = (yield* service.list())[0]!;
        expect(agent.projectId).toBe(config.projectId);
        expect(agent.intervalSeconds).toBe(3600);
        expect(agent.wakeOnTaskChanges).toBe(false);
        expect((yield* service.read({ id: config.id })).chat).toHaveLength(1);
        expect(
          (yield* service
            .command({ type: "save", config: { ...config, projectId: null } }, threadId)
            .pipe(Effect.flip)).message,
        ).toContain("chef_rules");
        yield* service.command({ type: "pause", id: config.id });
        expect(
          (yield* service
            .chefRules(threadId, { mission: "Autre règle", intervalSeconds: 30 })
            .pipe(Effect.flip)).message,
        ).toContain("Chef actif");
        yield* service.command({
          type: "message",
          id: config.id,
          messageId: "paused",
          text: "À lire à la reprise",
        });
        yield* service.tick();
        expect(f.sent).toHaveLength(0);
        expect((yield* service.list())[0]?.paused).toBe(true);
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect("wakes a parked Chef on chat without approving its outstanding request", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const sql = yield* SqlClient.SqlClient;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      const threadId = f.launched[0]!;
      const payload = JSON.stringify({ threadId, status: "pending", delivery: "none" });
      yield* sql`INSERT INTO agent_requests (id, payload_json) VALUES ('deploy', ${payload})`;
      yield* service.finish(threadId, "Déploiement à arbitrer", "Attente");
      yield* service.tick();
      expect(f.snoozed).toContain(threadId);
      yield* service.command({
        type: "message",
        id: config.id,
        messageId: "why",
        text: "Explique le risque",
      });
      yield* service.tick();
      expect(f.sent[0]?.threadId).toBe(threadId);
      expect(f.launched).toHaveLength(1);
      expect(
        (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM agent_requests WHERE id = 'deploy'`)[0]?.payload_json,
      ).toBe(payload);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("reacts to new work before the fallback interval, without repeating empty passes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const tasks = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      yield* service.finish(f.launched[0]!, "", "Rien à faire");
      yield* service.tick();
      yield* service.tick();
      expect(f.launched).toHaveLength(1);
      const now = "2026-11-04T12:00:00Z";
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('test-project','Test','/tmp/test','[]',${now},${now})`;
      yield* tasks.save({
        id: "ready",
        title: "Corriger une erreur",
        notes: "Contexte",
        status: "ready",
        projectId: config.projectId,
        agentThreadId: null,
        dueDate: null,
        expectedVersion: 0,
      });
      yield* service.tick();
      expect(f.launched).toHaveLength(2);
      expect(f.launchInputs[1]?.initialMessage?.text).toContain("Corriger une erreur");
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect(
  "wakes the Chef on worker lifecycle changes, without waking on each streamed update",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Agents.AutonomousAgentService;
        const tasks = yield* Tasks.WorkTaskService;
        const sql = yield* SqlClient.SqlClient;
        const config = chefConfig();
        const worker = ThreadId.make("worker");
        const now = "2026-11-04T12:00:00Z";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('test-project','Test','/tmp/test','[]',${now},${now})`;
        yield* tasks.save({
          id: "worker-task",
          title: "Travail en cours",
          notes: "",
          status: "doing",
          projectId: config.projectId,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
        yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.agentThreadId', ${worker}) WHERE id = 'worker-task'`;
        yield* service.command({ type: "save", config });
        yield* service.command({ type: "resume", id: config.id });
        yield* service.tick();
        yield* service.finish(f.launched[0]!, "", "Agent en cours");
        yield* service.tick();
        const shell = liveThreadShell(worker);
        f.shells.set(worker, { updatedAt: shell.createdAt });
        yield* service.tick();
        expect(f.launched).toHaveLength(1);
        f.shells.set(worker, { status: shell.status === "running" ? "idle" : "running" });
        yield* service.tick();
        expect(f.launched).toHaveLength(2);
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect(
  "includes every claimed chat message when more messages are queued than fit in recent context",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Agents.AutonomousAgentService;
        const config = chefConfig();
        yield* service.command({ type: "save", config });
        for (let i = 0; i < 25; i++)
          yield* service.command({
            type: "message",
            id: config.id,
            messageId: `queued-${i}`,
            text: `Consigne importante ${i}`,
          });
        yield* service.command({ type: "resume", id: config.id });
        yield* service.tick();
        const prompt = f.launchInputs[0]!.initialMessage!.text;
        for (let i = 0; i < 20; i++) expect(prompt).toContain(`Consigne importante ${i}`);
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{
            n: number;
          }>`SELECT count(*) AS n FROM chef_messages WHERE delivered = 0`)[0]?.n,
        ).toBe(5);
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect("preserves Chef identity and wake rules when an older client saves a configuration", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = { ...chefConfig(), wakeOnTaskChanges: false };
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      const { kind: _kind, wakeOnTaskChanges: _wake, ...legacyConfig } = config;
      yield* service.command({ type: "save", config: { ...legacyConfig, x: 99 } });
      const stored = (yield* service.list())[0]!;
      expect(stored.kind).toBe("chef");
      expect(stored.wakeOnTaskChanges).toBe(false);
      expect(stored.x).toBe(99);
      expect(stored.currentThreadId).toBe(f.launched[0]);
      expect(stored.projectId).toBe(config.projectId);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("reconciles a finished parked pass whose question has been withdrawn", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const sql = yield* SqlClient.SqlClient;
      const config = chefConfig();
      const old = ThreadId.make("withdrawn-pass");
      yield* service.command({ type: "save", config });
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,completed,waiting_for) VALUES (${old},${config.id},'Old pass','','',1,'human')`;
      yield* service.tick();
      const rows = yield* sql<{
        finished_at: string | null;
        waiting_for: string | null;
      }>`SELECT finished_at,waiting_for FROM autonomous_agent_runs WHERE thread_id=${old}`;
      expect(rows[0]?.finished_at).toBeTruthy();
      expect(rows[0]?.waiting_for).toBeNull();
      expect(f.archived).toContain(old);
      yield* service.command({
        type: "save",
        config: { ...config, projectId: ProjectId.make("new-project") },
      });
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("counts only new Chef messages and acknowledges exactly what was displayed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({
        type: "message",
        id: config.id,
        messageId: "human",
        text: "Bonjour",
      });
      expect((yield* service.list())[0]?.unreadCount).toBe(0);
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      const thread = f.launched[0]!;
      yield* service.chefMessage(thread, "first", "Un premier message");
      yield* service.chefMessage(thread, "first", "Un premier message");
      yield* service.chefMessage(thread, "newer", "Arrivé pendant la lecture");
      expect((yield* service.list())[0]?.unreadCount).toBe(2);
      yield* service.command({ type: "read", id: config.id, messageId: "first" });
      expect((yield* service.list())[0]?.unreadCount).toBe(1);
      yield* service.command({ type: "read", id: config.id, messageId: "newer" });
      expect((yield* service.list())[0]?.unreadCount).toBe(0);
      yield* service.command({ type: "read", id: config.id, messageId: "first" });
      expect((yield* service.list())[0]?.unreadCount).toBe(0);
      yield* service.chefMessage(thread, "third", "Encore une nouveauté");
      expect((yield* service.list())[0]?.unreadCount).toBe(1);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("can mark the last Chef message unread again without reopening the whole history", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      for (const id of ["a", "b", "c"]) yield* service.chefMessage(f.launched[0]!, id, id);
      yield* service.command({ type: "read", id: config.id, messageId: "c" });
      yield* service.command({ type: "unread", id: config.id, messageId: "c" });
      expect((yield* service.list())[0]?.unreadCount).toBe(1);
      yield* service.command({ type: "read", id: config.id, messageId: "c" });
      expect((yield* service.list())[0]?.unreadCount).toBe(0);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("persists read state across configuration and worker changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const sql = yield* SqlClient.SqlClient;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      const thread = f.launched[0]!;
      yield* service.chefMessage(thread, "seen", "Lu");
      yield* service.command({ type: "read", id: config.id, messageId: "seen" });
      const read = (yield* service.list())[0]!.chatReadThrough;
      yield* service.command({ type: "save", config: { ...config, x: 99 } });
      yield* service.chefRules(thread, { mission: "Règle modifiée", intervalSeconds: 1800 });
      yield* service.chefMessage(thread, "unseen", "Non lu");
      yield* service.finish(thread, "Mémoire", "Passage terminé");
      yield* service.tick();
      const stored = (yield* sql<{
        cursor: number;
        count: number | null;
      }>`SELECT json_extract(payload_json, '$.chatReadThrough') AS cursor, json_extract(payload_json, '$.unreadCount') AS count FROM autonomous_agents WHERE id = ${config.id}`)[0]!;
      expect(stored.cursor).toBe(read);
      expect(stored.count).toBeNull();
      expect((yield* service.list())[0]?.unreadCount).toBe(1);
      expect((yield* service.read({ id: config.id })).chat?.map((m) => m.id)).toEqual([
        "seen",
        "unseen",
      ]);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect("refuses read receipts for another Chef's message or for user messages", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Agents.AutonomousAgentService;
      const config = chefConfig();
      yield* service.command({ type: "save", config });
      yield* service.command({
        type: "save",
        config: { ...config, id: "other-chef", projectId: ProjectId.make("other-project") },
      });
      yield* service.command({ type: "resume", id: config.id });
      yield* service.tick();
      yield* service.chefMessage(f.launched[0]!, "private-message", "Un message");
      expect(
        (yield* service
          .command({ type: "read", id: "other-chef", messageId: "private-message" })
          .pipe(Effect.flip)).message,
      ).toContain("introuvable");
      yield* service.command({
        type: "message",
        id: config.id,
        messageId: "user-only",
        text: "Question",
      });
      expect(
        (yield* service
          .command({ type: "read", id: config.id, messageId: "user-only" })
          .pipe(Effect.flip)).message,
      ).toContain("introuvable");
      expect((yield* service.list()).find((a) => a.id === config.id)?.unreadCount).toBe(1);
    }).pipe(Effect.provideContext(f.context));
  }).pipe(Effect.scoped),
);

it.effect(
  "creating and enriching a tracked task from Inbox never wakes the Chef, while an automatic edit still wakes it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Agents.AutonomousAgentService,
          tasks = yield* Tasks.WorkTaskService;
        const actions = yield* InboxActions.InboxSubjectActions,
          sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('test-project','Test','/tmp/test','[]','','')`;
        const config = chefConfig();
        const original = yield* tasks.save({
          id: "tracked",
          title: "Déjà suivie",
          notes: "Notes humaines",
          status: "ready",
          projectId: config.projectId,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
        const control = yield* tasks.save({
          ...original,
          id: "control",
          title: "Témoin automatique",
          expectedVersion: 0,
        });
        yield* service.command({ type: "save", config });
        yield* service.command({ type: "resume", id: config.id });
        yield* service.tick();
        yield* service.finish(f.launched[0]!, "", "Repos");
        yield* service.tick();
        yield* service.tick();
        expect(f.launched).toHaveLength(1);
        for (const id of ["new", "enrich"])
          yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at) VALUES(${id},${id},'Résumé','')`;
        yield* actions.apply({
          kind: "create",
          subjectId: "new",
          expectedVersion: 0,
          requestId: "new",
          title: "Nouvelle manuelle",
          description: "Texte revu",
          projectId: config.projectId,
        });
        yield* service.tick();
        expect(f.launched).toHaveLength(1);
        yield* sql`UPDATE inbox_subjects SET task_id=${original.id} WHERE id='enrich'`;
        yield* actions.apply({
          kind: "update",
          subjectId: "enrich",
          expectedVersion: 0,
          requestId: "enrich",
          title: original.title,
          description: "Précision",
          projectId: original.projectId,
          taskId: original.id,
          taskVersion: original.version,
        });
        yield* service.tick();
        yield* service.tick();
        expect(f.launched).toHaveLength(1);
        yield* tasks.save({
          ...control,
          expectedVersion: control.version,
          notes: "Nouveau contexte automatique",
        });
        yield* service.tick();
        expect(f.launched).toHaveLength(2);
        expect(f.launchInputs[1]?.initialMessage?.text).toContain("Témoin automatique");
        expect(f.launchInputs[1]?.initialMessage?.text).not.toContain("Nouvelle manuelle");
        expect(f.launchInputs[1]?.initialMessage?.text).not.toContain("Déjà suivie");
      }).pipe(Effect.provide(InboxActions.layer), Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);

it.effect.each(["todo", "unqualified"] as const)(
  "keeps historical %s agents readable but never lets them take ready tasks",
  (trigger) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const agents = yield* Agents.AutonomousAgentService;
        const tasks = yield* Tasks.WorkTaskService;
        const sql = yield* SqlClient.SqlClient;
        const config = { ...agentConfig("old-tri", trigger), projectId: null };
        const stored = {
          ...config,
          paused: false,
          currentThreadId: null,
          status: "idle",
          error: null,
          nextRunAt: 0,
        };
        yield* sql`INSERT INTO autonomous_agents(id,payload_json) VALUES(${config.id},${JSON.stringify(stored)})`;
        yield* sql`INSERT INTO autonomous_agent_runs(thread_id,agent_id,title,prompt,started_at,finished_at)
        VALUES('historical-run',${config.id},'History','','before','after')`;
        for (const manual of [false, true])
          yield* tasks.save({
            id: `ready-${manual}`,
            expectedVersion: 0,
            title: "Action",
            notes: "",
            status: "ready",
            projectId: null,
            agentThreadId: null,
            dueDate: null,
            ...(manual ? { automationMode: "manual" as const } : {}),
          });
        yield* agents.tick();
        expect(f.launched).toHaveLength(0);
        expect((yield* agents.read({ id: config.id })).history).toHaveLength(1);
        expect(
          (yield* agents.command({ type: "resume", id: config.id }).pipe(Effect.flip)).message,
        ).toContain("retiré");
        expect(
          (yield* agents.command({ type: "save", config }).pipe(Effect.flip)).message,
        ).toContain("retirés");
        expect((yield* agents.list()).find((a) => a.id === config.id)).toMatchObject(stored);
        expect((yield* tasks.list()).every((t) => t.status === "ready" && t.version === 1)).toBe(
          true,
        );
      }).pipe(Effect.provideContext(f.context));
    }).pipe(Effect.scoped),
);
