import { taskImageTestLayer } from "./WorkTaskService.testkit.ts";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type WorkTaskSaveInput,
  type WorkChantierSaveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "./WorkTaskAgentService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-11-02T10:00:00.000Z";
  for (const id of ["project", "other"])
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, ${id}, '/tmp/project', '[]', ${now}, ${now})`;
  for (const id of ["thread", "second"])
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, '{}')`;
  return yield* Tasks.WorkTaskService;
});
const chantier = (id = "chantier"): WorkChantierSaveInput => ({
  id,
  expectedVersion: 0,
  title: "Caisse",
  projectId: ProjectId.make("project"),
  status: "active",
  objective: "Vente en caisse",
  scope: "Intégration des règles existantes",
  decisions: "Ne pas recréer la gestion des prix",
  targetPeriod: "Novembre",
  sources: [{ kind: "meeting", label: "Point équipe", url: null }],
  externalDependencies: [
    { id: "contract", title: "Contrat promotions", owner: "Produits", done: false },
  ],
});
const task = (id: string, dependsOn: string[] = []): WorkTaskSaveInput => ({
  id,
  expectedVersion: 0,
  title: id,
  notes: "",
  status: "ready",
  projectId: ProjectId.make("project"),
  agentThreadId: null,
  dueDate: null,
  chantierId: "chantier",
  dependsOn,
});
const layer = Tasks.layer.pipe(
  Layer.provide(taskImageTestLayer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("applies a plan with forward references atomically and preserves omitted work", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    const saved = yield* service.applyPlan({
      chantier: chantier(),
      tasks: [task("payment", ["prices"]), task("prices")],
    });
    expect((yield* service.list()).map((t) => t.id).sort()).toEqual(["payment", "prices"]);
    const prices = yield* service.read("prices");
    const updated = yield* service.applyPlan({
      chantier: {
        ...saved,
        decisions: "Premier lot sans promotions",
        expectedVersion: saved.version,
      },
      tasks: [{ ...prices, milestone: "Premier lot", expectedVersion: prices.version }],
    });
    expect((yield* service.read("payment")).dependsOn).toEqual(["prices"]);
    expect(updated.sources).toEqual(saved.sources);
    expect(
      (yield* service
        .applyPlan({
          chantier: { ...updated, scope: "SHOULD ROLLBACK", expectedVersion: updated.version },
          tasks: [{ ...prices, expectedVersion: prices.version }],
        })
        .pipe(Effect.flip)).reason,
    ).toBe("conflict");
    expect((yield* service.readChantier(saved.id)).scope).toBe(saved.scope);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects cycles, missing dependencies and cross-chantier changes without losing a plan",
  () =>
    Effect.gen(function* () {
      const service = yield* setup;
      expect(
        (yield* service
          .applyPlan({ chantier: chantier(), tasks: [task("a", ["b"]), task("b", ["a"])] })
          .pipe(Effect.flip)).reason,
      ).toBe("cycle");
      expect(yield* service.listChantiers()).toHaveLength(0);
      yield* service.applyPlan({ chantier: chantier(), tasks: [task("a"), task("b", ["a"])] });
      const a = yield* service.read("a");
      expect(
        (yield* service
          .save({ ...a, dependsOn: ["missing"], expectedVersion: a.version })
          .pipe(Effect.flip)).reason,
      ).toBe("dependencies");
      expect(
        (yield* service.delete({ id: "a", expectedVersion: a.version }).pipe(Effect.flip)).reason,
      ).toBe("referenced");
      expect(
        (yield* service
          .save({ ...a, chantierId: null, expectedVersion: a.version })
          .pipe(Effect.flip)).reason,
      ).toBe("dependencies");
      expect(
        (yield* service
          .save({ ...a, dependsOn: ["a"], expectedVersion: a.version })
          .pipe(Effect.flip)).reason,
      ).toBe("cycle");
      const c = yield* service.readChantier("chantier");
      expect(
        (yield* service
          .saveChantier({ ...c, projectId: ProjectId.make("other"), expectedVersion: c.version })
          .pipe(Effect.flip)).reason,
      ).toBe("project");
      expect((yield* service.read("a")).version).toBe(a.version);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "only delivered internal and external prerequisites unlock execution, and paused chantiers refuse starts",
  () =>
    Effect.gen(function* () {
      const service = yield* setup;
      let c = yield* service.applyPlan({
        chantier: chantier(),
        tasks: [
          task("prices"),
          { ...task("promotions", ["prices"]), externalDependsOn: ["contract"] },
        ],
      });
      const promotions = yield* service.read("promotions");
      const prices = yield* service.read("prices");
      expect((yield* service.assertCanStart(promotions).pipe(Effect.flip)).reason).toBe(
        "dependencies",
      );
      for (const status of ["review", "rejected", "merged"] as const) {
        const current = yield* service.read("prices");
        yield* service.save({ ...current, status, expectedVersion: current.version });
        expect((yield* service.assertCanStart(promotions).pipe(Effect.flip)).reason).toBe(
          "dependencies",
        );
      }
      const current = yield* service.read("prices");
      yield* service.save({ ...prices, status: "done", expectedVersion: current.version });
      expect(
        (yield* service
          .save({ ...promotions, status: "doing", expectedVersion: promotions.version })
          .pipe(Effect.flip)).reason,
      ).toBe("dependencies");
      c = yield* service.saveChantier({
        ...c,
        externalDependencies: c.externalDependencies.map((e) => ({ ...e, done: true })),
        expectedVersion: c.version,
      });
      yield* service.assertCanStart(promotions);
      c = yield* service.saveChantier({ ...c, status: "paused", expectedVersion: c.version });
      expect((yield* service.assertCanStart(promotions).pipe(Effect.flip)).reason).toBe(
        "preparation",
      );
      yield* service.saveChantier({ ...c, status: "active", expectedVersion: c.version });
      yield* service.assertCanStart(promotions);
    }).pipe(Effect.provide(layer)),
);

it.effect("retains chantier metadata on legacy saves and sends completed execution to review", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.saveChantier(chantier());
    const t = yield* service.save({
      ...task("t"),
      sources: [{ kind: "quote", label: "Devis", url: "https://example.com/quote" }],
      acceptanceCriteria: "Vente validée",
      agentThreadId: ThreadId.make("thread"),
      status: "doing",
    });
    yield* service.save({
      id: t.id,
      title: "Renommé",
      notes: "Résultat",
      projectId: t.projectId,
      status: t.status,
      dueDate: null,
      agentThreadId: t.agentThreadId,
      expectedVersion: t.version,
    });
    yield* service.completeForSettledThread(ThreadId.make("thread"));
    const reviewed = yield* service.read(t.id);
    expect(reviewed.status).toBe("review");
    expect(reviewed.chantierId).toBe("chantier");
    expect(reviewed.sources).toEqual(t.sources);
    expect(reviewed.acceptanceCriteria).toBe(t.acceptanceCriteria);
    yield* service.completeForSettledThread(ThreadId.make("thread"));
    expect((yield* service.read(t.id)).version).toBe(reviewed.version);
  }).pipe(Effect.provide(layer)),
);

it.effect("owns one permanent discussion and supports releasing and replacing it", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    let c = yield* service.saveChantier(chantier());
    c = yield* service.claimChantier(ThreadId.make("thread"), {
      id: c.id,
      expectedVersion: c.version,
    });
    expect(
      (yield* service
        .claimChantier(ThreadId.make("second"), { id: c.id, expectedVersion: c.version })
        .pipe(Effect.flip)).reason,
    ).toBe("conflict");
    c = yield* service.claimChantier(
      ThreadId.make("thread"),
      { id: c.id, expectedVersion: c.version },
      true,
    );
    c = yield* service.claimChantier(ThreadId.make("second"), {
      id: c.id,
      expectedVersion: c.version,
    });
    expect(c.orchestratorThreadId).toBe("second");
    expect(c.decisions).toBe(chantier().decisions);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "launches an orchestrator once with durable context instructions and blocks a dependent execution",
  () => {
    const launched: Launch.ThreadLaunchInput[] = [];
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
              yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${input.threadId!}, ${input.projectId}, ${input.title}, 'codex', 'full-access', 'default', 'now', 'now', '{}')`.pipe(
                Effect.orDie,
              );
              return {
                threadId: input.threadId!,
                resumed: false,
                projection: idleThreadProjection(liveThreadShell(input.threadId!)),
              };
            }),
        });
      }),
    );
    return Effect.gen(function* () {
      const service = yield* setup;
      const agents = yield* Agents.WorkTaskAgentService;
      const c = yield* service.applyPlan({
        chantier: chantier(),
        tasks: [task("a"), task("b", ["a"])],
      });
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
      const first = yield* agents.launchChantier({
        id: c.id,
        expectedVersion: c.version,
        modelSelection,
      });
      expect(first.orchestratorThreadId).toBe(launched[0]?.threadId);
      yield* agents.launchChantier({
        id: first.id,
        expectedVersion: first.version,
        modelSelection,
      });
      expect(launched).toHaveLength(1);
      expect(launched[0]?.initialMessage?.text).toContain("work_chantier_read");
      const sql = yield* SqlClient.SqlClient;
      const a = yield* service.read("a");
      for (const trigger of ["unqualified", "todo"]) {
        const caller = ThreadId.make(`autonomous-${trigger}`);
        yield* sql`INSERT INTO autonomous_agents (id,payload_json) VALUES (${trigger}, ${JSON.stringify({ trigger })})`;
        yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id) VALUES (${caller},${trigger},'Passage','','',${a.id})`;
        expect(
          (yield* agents
            .launch({ id: a.id, expectedVersion: a.version, modelSelection }, caller)
            .pipe(Effect.flip)).reason,
        ).toBe("chantierScope");
        expect(launched).toHaveLength(1);
        expect(yield* service.read(a.id)).toEqual(a);
      }
      const b = yield* service.read("b");
      expect(
        (yield* agents
          .launch({ id: b.id, expectedVersion: b.version, modelSelection })
          .pipe(Effect.flip)).reason,
      ).toBe("dependencies");
      expect(launched).toHaveLength(1);
    }).pipe(
      Effect.provide(
        Agents.layer.pipe(
          Layer.provideMerge(Tasks.layer.pipe(Layer.provide(taskImageTestLayer))),
          Layer.provide(launcher),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);

it.effect.each(["unqualified", "todo"] as const)(
  "%s agents cannot edit, detach, attach, claim or replan chantier tasks, including old runs",
  (trigger) =>
    Effect.gen(function* () {
      const service = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const c = yield* service.saveChantier(chantier());
      const attached = yield* service.save({ ...task("attached"), status: "ready" });
      const ordinary = yield* service.save({
        ...task("ordinary"),
        chantierId: null,
        status: "ready",
      });
      const caller = ThreadId.make("thread");
      yield* sql`INSERT INTO autonomous_agents (id, payload_json) VALUES ('worker', ${JSON.stringify({ trigger, paused: true, currentThreadId: null, projectId: "project" })})`;
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id,finished_at) VALUES (${caller},'worker','Old passage','','',${attached.id},'now')`;
      for (const chantierFields of [{}, { chantierId: null }, { chantierId: "chantier" }]) {
        expect(
          (yield* service
            .save(
              {
                ...attached,
                ...chantierFields,
                title: "Changed",
                expectedVersion: attached.version,
              },
              caller,
            )
            .pipe(Effect.flip)).reason,
        ).toBe(trigger === "unqualified" ? "preparation" : "chantierScope");
      }
      expect(
        (yield* service.save({ ...task("new"), status: "ready" }, caller).pipe(Effect.flip)).reason,
      ).toBe(trigger === "unqualified" ? "preparation" : "chantierScope");
      expect(
        (yield* service
          .claim(caller, { id: attached.id, expectedVersion: attached.version })
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      expect(
        (yield* service
          .claim(caller, { id: attached.id, expectedVersion: attached.version }, true)
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      expect((yield* service.assertCanStart(attached, caller).pipe(Effect.flip)).reason).toBe(
        "chantierScope",
      );
      expect(
        (yield* service
          .saveChantier({ ...c, scope: "Changed", expectedVersion: c.version }, caller)
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      expect(
        (yield* service
          .claimChantier(caller, { id: c.id, expectedVersion: c.version })
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      expect(
        (yield* service
          .applyPlan(
            {
              chantier: { ...c, scope: "Changed", expectedVersion: c.version },
              tasks: [{ ...attached, title: "Changed", expectedVersion: attached.version }],
            },
            caller,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("chantierScope");
      yield* sql`UPDATE autonomous_agent_runs SET task_id = ${ordinary.id} WHERE thread_id = ${caller}`;
      expect(
        (yield* service
          .save({ ...ordinary, chantierId: c.id, expectedVersion: ordinary.version }, caller)
          .pipe(Effect.flip)).reason,
      ).toBe(trigger === "unqualified" ? "preparation" : "chantierScope");
      if (trigger === "todo") {
        const updated = yield* service.save(
          { ...ordinary, title: "Clarifiée", expectedVersion: ordinary.version },
          caller,
        );
        expect(updated.title).toBe("Clarifiée");
      }
      expect(yield* service.read(attached.id)).toEqual(attached);
      expect(yield* service.readChantier(c.id)).toEqual(c);
      const manual = yield* service.save({
        ...attached,
        title: "Manuel",
        expectedVersion: attached.version,
      });
      const orchestrated = yield* service.save(
        { ...manual, title: "Orchestré", expectedVersion: manual.version },
        ThreadId.make("second"),
      );
      expect(orchestrated.title).toBe("Orchestré");
    }).pipe(Effect.provide(layer)),
);
