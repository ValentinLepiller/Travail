import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChefError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChefMemoryDraft,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Requests from "../agentRequests/AgentRequestService.ts";
import * as RequestEffects from "../agentRequests/RequestEffects.ts";
import * as Config from "../config.ts";
import * as Actions from "../inbox/InboxSubjectActions.ts";
import * as Inbox from "../inbox/MessageInbox.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "../workTasks/WorkTaskService.ts";
import * as Chef from "./GlobalChefService.ts";
import * as Runtime from "./ChefRuntime.ts";
import type { ChefPlan } from "./chefDecision.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const projectId = ProjectId.make("chef-project");
const modelSelection = { instanceId: ProviderInstanceId.make("test"), model: "fixture" };
const memory: ChefMemoryDraft = {
  kind: "rule",
  text: "Créer une tâche pour les demandes de correction du projet.",
  scope: { kind: "project", id: projectId },
  topic: "Demandes de correction",
  action: "create",
};
const plan = (extra: Partial<ChefPlan> = {}): ChefPlan => ({
  kind: "create",
  title: "Corriger le formulaire",
  description: "Corriger le formulaire selon le message source.",
  taskId: null,
  threadId: null,
  reason: "Demande explicite de correction.",
  uncertain: false,
  memory,
  ruleId: null,
  matchingRuleIds: extra.ruleId ? [extra.ruleId] : [],
  ...extra,
});
const reply = (extra: Partial<ChefPlan> = {}) =>
  encode({ reply: "Je propose de créer la tâche.", plan: plan(extra) });
const layer = (
  generate: Runtime.ChefRuntime["Service"]["generate"] = () => Effect.succeed(reply()),
  notify: Runtime.ChefRuntime["Service"]["notify"] = () => Effect.void,
  db: ReturnType<typeof Sqlite.layerFromPath> = Sqlite.layerMemory,
  inspect: Runtime.ChefRuntime["Service"]["inspect"] = () =>
    Effect.succeed({ status: "ready", checkedAt: "now", text: "[]", truncated: false }),
) =>
  Chef.layer.pipe(
    Layer.provideMerge(Actions.layer.pipe(Layer.provideMerge(Tasks.layer))),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(
      Requests.layer.pipe(
        Layer.provide(
          Layer.succeed(RequestEffects.RequestEffects, {
            execute: () => Effect.die("No command execution from Chef requests"),
            notify: () => Effect.die("No execution thread may be resumed by a Chef request"),
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(Runtime.ChefRuntime, {
        generate,
        inspect,
        notify,
        ensureDossier: () => Effect.void,
        conversation: () => Effect.succeed({ text: "Échange lu", truncated: false }),
      }),
    ),
    Layer.provideMerge(db),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "chef-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const seed = (id = "alpha") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES(${projectId},'Projet test','/tmp/chef-test','[]','','')`;
    yield* (yield* Inbox.MessageInbox).ingestGmail({
      accountEmail: "me@example.com",
      id,
      threadId: id,
      receivedAt: "1793278000.000001",
      sender: "Client <client@example.com>",
      subject: "Correction",
      text: `Corriger ${id}`,
    });
    yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.context',json('{"version":1,"status":"ready","checkedAt":"now","messages":[],"truncated":false,"reason":null}')) WHERE id=${`gmail:me@example.com:${id}`}`;
    yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at,context_json,context_updated_at)
    VALUES(${id},${`Correction ${id}`},'Demande de correction','',${encode({ kind: "project", id: projectId, projectId })},'2026-11-12T00:00:00Z')`;
    yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json)
    VALUES(${`gmail:me@example.com:${id}`},${id},'','{}')`;
    yield* sql`UPDATE inbox_subjects SET context_sequence=(SELECT MAX(sequence) FROM message_inbox) WHERE id=${id}`;
  });
const enable = Effect.gen(function* () {
  yield* (yield* Chef.GlobalChefService).command({
    type: "configure",
    enabled: true,
    projectId,
    modelSelection,
  });
});

it.effect(
  "approval creates one sourced ready task, never memorizes implicitly and never resumes its discussion",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      expect(yield* tasks.list()).toHaveLength(0);
      const [r] = yield* requests.list();
      expect(r?.chef?.memory?.text).toBe(memory.text);
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        text: "",
      });
      yield* requests.drain();
      yield* service.processNext();
      yield* service.processNext();
      const [task] = yield* tasks.list();
      expect(task).toMatchObject({
        status: "ready",
        automationMode: "manual",
        agentThreadId: null,
        inboxSubjectIds: ["alpha"],
      });
      expect(task?.sources?.[0]?.kind).toBe("email");
      expect(yield* tasks.list()).toHaveLength(1);
      expect((yield* service.memory({})).memories).toHaveLength(0);
      expect((yield* requests.list())[0]).toMatchObject({
        actionStatus: "succeeded",
        delivery: "none",
        chef: { remember: false },
      });
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "memorize saves exactly the displayed phrase and authorizes only matching future actions",
  () => {
    let ruleId: string | null = null;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        remember: true,
        text: "",
      });
      yield* service.processNext();
      const [m] = (yield* service.memory({})).memories;
      expect(m?.text).toBe(memory.text);
      ruleId = m!.id;
      yield* seed("beta");
      yield* service.processNext();
      yield* service.processNext();
      expect(yield* tasks.list()).toHaveLength(2);
      expect(yield* requests.list()).toHaveLength(1);
    }).pipe(Effect.provide(layer(() => Effect.sync(() => reply({ ruleId })))));
  },
);

it.effect(
  "equivalent cases share one versioned request and one-off acceptance stays limited to the reviewed batch",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* seed("beta");
      yield* enable;
      yield* service.processNext();
      yield* service.processNext();
      const [r] = yield* requests.list();
      expect(yield* requests.list()).toHaveLength(1);
      expect(r?.chef?.dossierIds).toEqual(["alpha", "beta"]);
      expect(r?.version).toBe(2);
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        text: "",
      });
      yield* seed("gamma");
      yield* service.processNext();
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(2);
      expect(yield* requests.list()).toHaveLength(2);
      expect((yield* service.read({ id: "gamma" })).dossier.state).toBe("waiting");
    }).pipe(Effect.provide(layer())),
);

it.effect("a waiting request or a failing model never blocks independent dossiers", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService;
    yield* seed();
    yield* seed("beta");
    yield* seed("gamma");
    yield* enable;
    yield* service.processNext();
    yield* service.processNext();
    yield* service.processNext();
    expect((yield* service.read({ id: "alpha" })).dossier.state).toBe("error");
    expect((yield* service.read({ id: "beta" })).dossier.state).toBe("waiting");
    expect((yield* service.read({ id: "gamma" })).dossier.state).toBe("waiting");
    expect((yield* service.status()).errors).toBe(1);
    expect(calls).toBe(3);
  }).pipe(
    Effect.provide(layer(() => Effect.sync(() => (++calls === 1 ? "invalid-json" : reply())))),
  );
});

it.effect("pause stays responsive while the model runs and discards its later proposal", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService;
      yield* seed();
      yield* enable;
      const fiber = yield* service.processNext().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.command({ type: "configure", enabled: false, projectId, modelSelection });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(yield* (yield* Requests.AgentRequestService).list()).toHaveLength(0);
      expect((yield* service.memory({})).memories).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(reply()),
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "a requested change updates the same grouped request only after all proposals are refreshed",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* seed("beta");
      yield* enable;
      yield* service.processNext();
      yield* service.processNext();
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "revise",
        text: "Précise les tests attendus.",
      });
      yield* service.processNext();
      expect((yield* requests.list())[0]?.status).toBe("revision");
      yield* service.processNext();
      const [revised] = yield* requests.list();
      expect(yield* requests.list()).toHaveLength(1);
      expect(revised).toMatchObject({ id: r!.id, status: "pending", version: 4 });
      expect(revised?.chef?.dossierIds).toEqual(["alpha", "beta"]);
    }).pipe(Effect.provide(layer())),
);

it.effect.each(["fact", "rule"] as const)(
  "a requested change to a %s memory proposal returns to approval without saving it",
  (kind) => {
    let generations = 0;
    const draft: ChefMemoryDraft = {
      ...memory,
      kind,
      text:
        kind === "rule"
          ? "Ignorer les confirmations de réservation Studio Bleu."
          : "Les confirmations Studio Bleu sont des courriels informatifs.",
      topic: "Confirmations Studio Bleu",
      action: kind === "rule" ? "ignore" : null,
    };
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [first] = yield* requests.list();
      yield* requests.respond({
        id: first!.id,
        expectedVersion: first!.version,
        decision: "revise",
        text: "Propose une phrase à mémoriser pour ces confirmations.",
      });
      yield* service.processNext();
      const [revised] = yield* requests.list();
      expect(revised).toMatchObject({
        id: first!.id,
        status: "pending",
        chef: { action: "remember", memoryOnly: true, memory: draft },
      });
      expect((yield* service.read({ id: "alpha" })).dossier.state).toBe("waiting");
      expect((yield* service.memory({})).memories).toHaveLength(0);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
      yield* requests.respond({
        id: revised!.id,
        expectedVersion: revised!.version,
        decision: "accept",
        remember: true,
        text: "",
      });
      yield* service.processNext();
      expect((yield* service.memory({})).memories[0]?.text).toBe(draft.text);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            ++generations === 1
              ? reply({ kind: "ignore", memory: null })
              : reply({ kind: "remember", memory: draft }),
          ),
        ),
      ),
    );
  },
);

it.effect("a stale subject approval has no task or memory side effects", () =>
  Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService,
      sql = yield* SqlClient.SqlClient;
    yield* seed();
    yield* enable;
    yield* service.processNext();
    const [r] = yield* requests.list();
    yield* requests.respond({
      id: r!.id,
      expectedVersion: r!.version,
      decision: "accept",
      remember: true,
      text: "",
    });
    yield* sql`UPDATE inbox_subjects SET action_version=action_version+1 WHERE id='alpha'`;
    yield* service.processNext();
    expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    expect((yield* service.memory({})).memories).toHaveLength(0);
    expect((yield* requests.list())[0]?.actionStatus).toBe("failed");
  }).pipe(Effect.provide(layer())),
);

it.effect("completing an existing task preserves its initial request and linked discussion", () =>
  Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService,
      tasks = yield* Tasks.WorkTaskService,
      sql = yield* SqlClient.SqlClient;
    yield* seed();
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
    VALUES('existing-chat',${projectId},'Correction','codex','approval-required','default','','','{}')`;
    const task = yield* tasks.save({
      id: "existing",
      expectedVersion: 0,
      title: "Demande initiale",
      notes: "Notes humaines intouchées",
      projectId,
      agentThreadId: ThreadId.make("existing-chat"),
      status: "doing",
      dueDate: null,
    });
    yield* enable;
    yield* service.processNext();
    const [r] = yield* requests.list();
    yield* requests.respond({
      id: r!.id,
      expectedVersion: r!.version,
      decision: "accept",
      text: "",
    });
    yield* service.processNext();
    const saved = yield* tasks.read(task.id);
    expect(saved.title).toBe("Demande initiale");
    expect(saved.notes).toContain("Notes humaines intouchées");
    expect(saved.notes).toContain("Nouveauté sourcée");
    expect(saved.agentThreadId).toBe("existing-chat");
    expect(saved.status).toBe("doing");
    expect(saved.inboxSubjectIds).toEqual(["alpha"]);
    expect((yield* service.memory({})).memories).toHaveLength(0);
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed(
          reply({
            kind: "complete",
            taskId: "existing",
            title: "Un titre à ne pas substituer",
            description: "Nouveauté sourcée",
            memory: { ...memory, action: "complete" },
          }),
        ),
      ),
    ),
  ),
);

it.effect("a newly disabled rule invalidates an automatic action already queued", () => {
  let ruleId: string | null = null;
  return Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService,
      tasks = yield* Tasks.WorkTaskService;
    yield* seed();
    yield* enable;
    yield* service.processNext();
    const [r] = yield* requests.list();
    yield* requests.respond({
      id: r!.id,
      expectedVersion: r!.version,
      decision: "accept",
      remember: true,
      text: "",
    });
    yield* service.processNext();
    const [m] = (yield* service.memory({})).memories;
    ruleId = m!.id;
    yield* seed("beta");
    yield* service.processNext();
    yield* service.command({ type: "memory", ...m!, expectedVersion: m!.version, enabled: false });
    yield* service.processNext();
    expect(yield* tasks.list()).toHaveLength(1);
    expect((yield* service.memory({})).memories[0]?.enabled).toBe(false);
    expect((yield* service.read({ id: "beta" })).dossier.state).toBe("error");
  }).pipe(Effect.provide(layer(() => Effect.sync(() => reply({ ruleId })))));
});

it.effect("a fact proposal creates no task and is saved only by an explicit memorize choice", () =>
  Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService;
    yield* seed();
    yield* seed("beta");
    yield* enable;
    yield* service.processNext();
    yield* service.processNext();
    const all = yield* requests.list();
    expect(all).toHaveLength(2);
    yield* requests.respond({
      id: all[0]!.id,
      expectedVersion: all[0]!.version,
      decision: "accept",
      text: "",
    });
    yield* requests.respond({
      id: all[1]!.id,
      expectedVersion: all[1]!.version,
      decision: "accept",
      remember: true,
      text: "",
    });
    yield* service.processNext();
    const memories = (yield* service.memory({})).memories;
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      kind: "fact",
      action: null,
      text: "Charlotte est l’interlocutrice du projet.",
    });
    expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed(
          reply({
            kind: "remember",
            title: "Contexte du projet",
            memory: {
              ...memory,
              kind: "fact",
              action: null,
              text: "Charlotte est l’interlocutrice du projet.",
            },
          }),
        ),
      ),
    ),
  ),
);

it.effect(
  "manual Inbox handling withdraws the obsolete proposal without repeating Luna or a task action",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      yield* (yield* Actions.InboxSubjectActions).apply({
        kind: "ignore",
        subjectId: "alpha",
        expectedVersion: 0,
        requestId: "human-ignore",
        ignored: true,
      });
      yield* service.processNext();
      expect((yield* requests.list())[0]?.status).toBe("withdrawn");
      expect((yield* service.read({ id: "alpha" })).dossier.state).toBe("done");
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "a committed action survives a failed receipt finalization and a database reopen without a duplicate",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "chef-recovery-" });
      const db = Sqlite.layerFromPath(`${dir}/state.sqlite`);
      yield* Effect.gen(function* () {
        const service = yield* Chef.GlobalChefService,
          requests = yield* Requests.AgentRequestService,
          sql = yield* SqlClient.SqlClient;
        yield* seed();
        yield* enable;
        yield* service.processNext();
        const [r] = yield* requests.list();
        yield* requests.respond({
          id: r!.id,
          expectedVersion: r!.version,
          decision: "accept",
          remember: true,
          text: "",
        });
        yield* sql`CREATE TRIGGER fail_finalization BEFORE UPDATE ON chef_decisions WHEN NEW.state='done'
      BEGIN SELECT RAISE(ABORT,'test interruption'); END`;
        expect((yield* service.processNext().pipe(Effect.flip)).reason).toBe("storage");
        expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(1);
        expect((yield* service.memory({})).memories).toHaveLength(0);
      }).pipe(Effect.provide(layer(undefined, undefined, db)));
      yield* Effect.gen(function* () {
        const service = yield* Chef.GlobalChefService,
          sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER fail_finalization`;
        yield* service.processNext();
        yield* service.processNext();
        expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(1);
        expect((yield* service.memory({})).memories).toHaveLength(1);
        expect((yield* (yield* Requests.AgentRequestService).list())[0]?.actionStatus).toBe(
          "succeeded",
        );
      }).pipe(Effect.provide(layer(undefined, undefined, db)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "discussing a pending proposal revises the same request instead of duplicating it",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [first] = yield* requests.list();
      yield* service.command({
        type: "message",
        id: "alpha",
        messageId: "clarification",
        text: "Ajoute les tests attendus.",
      });
      yield* service.processNext();
      const all = yield* requests.list();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: first!.id, version: 2, status: "pending" });
      expect(all[0]?.details).toContain("Avec tests attendus");
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            reply({ description: calls++ ? "Avec tests attendus" : "Demande initiale" }),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "handoff uses the selected task's chantier Chef, retries its notification and accepts only that active Chef's reply",
  () => {
    const notifications: Array<{ agentId: string; id: string }> = [];
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* tasks.saveChantier({
        id: "notifications",
        expectedVersion: 0,
        title: "Notifications",
        projectId,
        status: "active",
        objective: "Notifications",
        scope: "Notifications",
        decisions: "",
        targetPeriod: "",
        sources: [],
        externalDependencies: [],
        generation: "legacy",
      });
      yield* tasks.save({
        id: "existing",
        expectedVersion: 0,
        title: "Tâche notifications",
        notes: "Demande intacte",
        projectId,
        chantierId: "notifications",
        agentThreadId: null,
        status: "ready",
        dueDate: null,
      });
      for (const id of ["project-chef", "chantier-chef"]) {
        const a = {
          id,
          kind: id === "chantier-chef" ? "chantier-chef" : "chef",
          name: id,
          mission: "Mission de test",
          projectId,
          ...(id === "chantier-chef" ? { chantierId: "notifications" } : {}),
          modelSelection,
          intervalSeconds: 60,
          trigger: "interval",
          x: 0,
          y: 0,
          paused: false,
          currentThreadId: `${id}-run`,
          status: "working",
          error: null,
          nextRunAt: 0,
        };
        yield* sql`INSERT INTO autonomous_agents(id,payload_json) VALUES(${id},${encode(a)})`;
        yield* sql`INSERT INTO autonomous_agent_runs(thread_id,agent_id,title,prompt,started_at) VALUES(${`${id}-run`},${id},'Test','Test','')`;
      }
      yield* enable;
      yield* service.processNext();
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        text: "",
      });
      yield* service.processNext();
      expect((yield* service.status()).notificationsPending).toBe(1);
      yield* service.processNext();
      expect((yield* service.status()).notificationsPending).toBe(0);
      expect(notifications.map((n) => n.agentId)).toEqual(["chantier-chef", "chantier-chef"]);
      expect(notifications[1]?.id).toBe(notifications[0]?.id);
      const input = {
        id: "alpha",
        messageId: "chef-answer",
        text: "Je prends le cadrage en charge.",
      };
      expect(
        (yield* service.reply(ThreadId.make("project-chef-run"), input).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      yield* service.reply(ThreadId.make("chantier-chef-run"), input);
      yield* service.reply(ThreadId.make("chantier-chef-run"), input);
      expect(
        (yield* service.read({ id: "alpha" })).messages.filter((m) => m.role === "chef"),
      ).toHaveLength(1);
      expect((yield* tasks.read("existing")).notes).toBe("Demande intacte");
      expect((yield* service.memory({})).memories).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(
          () =>
            Effect.succeed(
              reply({
                kind: "handoff",
                taskId: "existing",
                memory: { ...memory, action: "handoff" },
              }),
            ),
          (agentId, id) =>
            Effect.gen(function* () {
              notifications.push({ agentId, id });
              if (notifications.length === 1)
                return yield* new ChefError({ reason: "storage", cause: "offline" });
            }),
        ),
      ),
    );
  },
);

it.effect("a rule edit while the model is responding discards its obsolete proposal", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        remember: true,
        text: "",
      });
      yield* service.processNext();
      const [m] = (yield* service.memory({})).memories;
      yield* seed("beta");
      const processing = yield* service.processNext().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.command({
        type: "memory",
        ...m!,
        expectedVersion: m!.version,
        enabled: false,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(processing);
      expect(yield* requests.list()).toHaveLength(1);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(1);
      expect((yield* service.read({ id: "beta" })).dossier.state).toBe("error");
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.gen(function* () {
            if (++calls === 2) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return reply();
          }),
        ),
      ),
    );
  }),
);

it.effect("an existing task supplies the reviewed scope even when Luna had no project", () =>
  Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService;
    yield* seed();
    yield* (yield* SqlClient.SqlClient)`UPDATE inbox_subjects SET context_json=NULL WHERE id='alpha'`;
    yield* (yield* Tasks.WorkTaskService).save({
      id: "existing",
      expectedVersion: 0,
      title: "Demande déjà engagée",
      notes: "À conserver",
      status: "doing",
      projectId,
      agentThreadId: null,
      dueDate: null,
    });
    yield* enable;
    yield* service.processNext();
    const [r] = yield* requests.list();
    expect(r?.details).toContain("Projet : Projet test");
    expect(r?.details).toContain("Tâche existante : Demande déjà engagée");
    expect(r?.chef?.memory?.scope).toEqual(memory.scope);
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed(
          reply({
            kind: "complete",
            taskId: "existing",
            memory: { ...memory, action: "complete" },
          }),
        ),
      ),
    ),
  ),
);

it.effect("a revised group labels each distinct action and cannot memorize a mixed rule", () => {
  let calls = 0;
  return Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      requests = yield* Requests.AgentRequestService;
    yield* seed();
    yield* seed("beta");
    yield* enable;
    yield* service.processNext();
    yield* service.processNext();
    const [r] = yield* requests.list();
    yield* requests.respond({
      id: r!.id,
      expectedVersion: r!.version,
      decision: "revise",
      text: "Ignorer le premier seulement.",
    });
    yield* service.processNext();
    yield* service.processNext();
    const [revised] = yield* requests.list();
    expect(revised?.id).toBe(r!.id);
    expect(revised?.question).toContain("Appliquer les actions proposées");
    expect(revised?.details).toContain("**Ignorer**");
    expect(revised?.details).toContain("**Créer une tâche**");
    expect(revised?.chef?.memory).toBeNull();
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.sync(() =>
          ++calls === 3
            ? reply({ kind: "ignore", memory: { ...memory, action: "ignore" } })
            : reply(),
        ),
      ),
    ),
  );
});

it.effect("large candidate histories stay bounded and visibly require review", () => {
  let prompt = "";
  return Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService,
      tasks = yield* Tasks.WorkTaskService;
    yield* seed();
    for (let i = 0; i < 70; i++)
      yield* tasks.save({
        id: `candidate-${i}`,
        expectedVersion: 0,
        title: `Correction ${i}`,
        notes: "Historique important. ".repeat(800),
        status: "ready",
        projectId,
        agentThreadId: null,
        dueDate: null,
      });
    yield* enable;
    yield* service.processNext();
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(60_000);
    expect(prompt).toContain('"searchIncomplete":true');
    expect(prompt).not.toContain('"attachments"');
    expect((yield* service.read({ id: "alpha" })).dossier.state).toBe("waiting");
    expect(yield* (yield* Requests.AgentRequestService).list()).toHaveLength(1);
    expect(yield* tasks.list()).toHaveLength(70);
  }).pipe(
    Effect.provide(
      layer((_, text) =>
        Effect.sync(() => {
          prompt = text;
          return reply();
        }),
      ),
    ),
  );
});

it.effect(
  "Luna's unfinished context defers only that subject and a closed subject withdraws its pending request",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        sql = yield* SqlClient.SqlClient,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* seed("beta");
      yield* sql`UPDATE inbox_subjects SET context_sequence=0 WHERE id='alpha'`;
      yield* enable;
      yield* service.processNext();
      expect((yield* service.list({})).dossiers.map((d) => d.id)).toEqual(["beta"]);
      yield* sql`UPDATE inbox_subjects SET context_sequence=(SELECT sequence FROM message_inbox WHERE id='gmail:me@example.com:alpha') WHERE id='alpha'`;
      yield* service.processNext();
      expect((yield* service.list({})).dossiers).toHaveLength(2);
      yield* sql`UPDATE inbox_subjects SET closed_at='2026-11-12'`;
      yield* service.processNext();
      expect((yield* service.list({})).dossiers).toHaveLength(0);
      expect(
        (yield* service.list({ archived: true })).dossiers.every(
          (d) => d.state === "closed" && d.requestId === null,
        ),
      ).toBe(true);
      expect((yield* requests.list()).every((r) => r.status === "withdrawn")).toBe(true);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "approved facts are loaded by project even when the new subject uses different words",
  () => {
    const prompts: string[] = [];
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        remember: true,
        text: "",
      });
      yield* service.processNext();
      yield* seed("beta");
      yield* service.processNext();
      expect(prompts[1]).toContain("Charlotte est l’interlocutrice du projet.");
      expect((yield* service.memory({})).memories).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layer((_, prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
            return reply({
              kind: "remember",
              memory: {
                ...memory,
                kind: "fact",
                action: null,
                text: "Charlotte est l’interlocutrice du projet.",
              },
            });
          }),
        ),
      ),
    );
  },
);

it.effect(
  "a new message updates the subject's own task without changing its origin or initial title",
  () => {
    let existing: string | null = null;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        sql = yield* SqlClient.SqlClient,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const accept = Effect.gen(function* () {
        const r = (yield* requests.list()).find((r) => r.status === "pending");
        yield* requests.respond({
          id: r!.id,
          expectedVersion: r!.version,
          decision: "accept",
          text: "",
        });
        yield* service.processNext();
      });
      yield* accept;
      const [first] = yield* tasks.list();
      existing = first!.id;
      yield* (yield* Inbox.MessageInbox).ingestGmail({
        accountEmail: "me@example.com",
        id: "followup",
        threadId: "alpha",
        receivedAt: "1793278001.000001",
        sender: "Client",
        subject: "Précision",
        text: "Nouveau détail",
      });
      yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES('gmail:me@example.com:followup','alpha','','{}')`;
      yield* sql`UPDATE inbox_subjects SET action_version=action_version+1,context_sequence=(SELECT MAX(sequence) FROM message_inbox) WHERE id='alpha'`;
      yield* service.processNext();
      yield* accept;
      const saved = yield* tasks.read(existing!);
      expect(saved.title).toBe(first!.title);
      expect(saved.notes).toContain("Précision ajoutée");
      expect(yield* tasks.list()).toHaveLength(1);
      expect(yield* sql`SELECT task_link_kind FROM inbox_subjects WHERE id='alpha'`).toEqual([
        { task_link_kind: "created" },
      ]);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            existing
              ? reply({
                  kind: "complete",
                  taskId: existing,
                  title: "Titre à ne pas substituer",
                  description: "Précision ajoutée",
                  memory: null,
                })
              : reply(),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "dossier cards and details expose their subject project instead of the Chef's hosting project",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      const target = ProjectId.make("subject-project");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${target},'Projet du sujet','/tmp/subject-project','[]','','')`;
      yield* sql`UPDATE inbox_subjects SET context_json=${encode({ kind: "project", id: target, projectId: target })} WHERE id='alpha'`;
      yield* sql`INSERT INTO chef_dossiers(id,subject_id,thread_id,title,updated_at) VALUES('alpha','alpha','chef-dossier:alpha','Sujet','')`;
      expect((yield* service.list({})).dossiers[0]?.projectId).toBe(target);
      expect((yield* service.read({ id: "alpha" })).dossier.projectId).toBe(target);
      yield* sql`UPDATE inbox_subjects SET context_json=NULL WHERE id='alpha'`;
      expect((yield* service.read({ id: "alpha" })).dossier.projectId).toBeNull();
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "project identity follows an existing task or chantier and honors a task without a project",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        sql = yield* SqlClient.SqlClient,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      const target = ProjectId.make("target-project");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${target},'Projet réel','/tmp/real-project','[]','','')`;
      const task = yield* tasks.save({
        id: "target",
        expectedVersion: 0,
        title: "Tâche existante",
        notes: "",
        status: "ready",
        projectId: target,
        agentThreadId: null,
        dueDate: null,
      });
      yield* sql`INSERT INTO chef_dossiers(id,subject_id,thread_id,title,updated_at) VALUES('alpha','alpha','chef-dossier:alpha','Sujet','')`;
      yield* sql`UPDATE inbox_subjects SET context_json=${encode({ kind: "task", id: task.id, projectId })} WHERE id='alpha'`;
      expect((yield* service.list({})).dossiers[0]?.projectId).toBe(target);
      yield* sql`UPDATE inbox_subjects SET task_id=${task.id},context_json=${encode({ kind: "project", id: projectId, projectId })} WHERE id='alpha'`;
      expect((yield* service.read({ id: "alpha" })).dossier.projectId).toBe(target);
      yield* tasks.save({ ...task, projectId: null, expectedVersion: task.version });
      expect((yield* service.read({ id: "alpha" })).dossier.projectId).toBeNull();
      yield* sql`INSERT INTO work_chantiers(id,version,payload_json) VALUES('chantier',1,${encode({ projectId: target, title: "Chantier" })})`;
      yield* sql`UPDATE inbox_subjects SET task_id=NULL,context_json=${encode({ kind: "chantier", id: "chantier", projectId })} WHERE id='alpha'`;
      expect((yield* service.list({})).dossiers[0]?.projectId).toBe(target);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "only essential missing business information asks a written question and its answer returns to review",
  () => {
    let generations = 0;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [question] = yield* requests.list();
      expect(question).toMatchObject({ kind: "text", chef: { action: "handoff", memory: null } });
      expect(question?.question).toBe(
        "Dans quel espace Notion faut-il enregistrer cette information ?",
      );
      expect(question?.chef?.projectId).toBe(projectId);
      expect(
        (yield* requests
          .respond({
            id: question!.id,
            expectedVersion: question!.version,
            decision: "accept",
            remember: true,
            text: "",
          })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid");
      yield* requests.respond({
        id: question!.id,
        expectedVersion: question!.version,
        decision: "answer",
        text: "Propose la tâche sans Chef pour ce cas.",
      });
      yield* service.processNext();
      const all = yield* requests.list();
      expect(all.find((r) => r.id === question!.id)?.status).toBe("answered");
      expect(all.find((r) => r.status === "pending")).toMatchObject({
        kind: "approval",
        chef: { action: "create" },
      });
      expect(
        (yield* service.read({ id: "alpha" })).messages.some(
          (m) => m.role === "user" && m.text.includes("sans Chef"),
        ),
      ).toBe(true);
      expect(yield* tasks.list()).toHaveLength(0);
      expect((yield* service.memory({})).memories).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            ++generations === 1
              ? reply({
                  kind: "handoff",
                  memory: null,
                  reason: "Le lieu où enregistrer cette information manque.",
                  question: "Dans quel espace Notion faut-il enregistrer cette information ?",
                })
              : reply(),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "the current native Chef directory is supplied even for a paused responsible Chef",
  () => {
    let prompt = "";
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient,
        service = yield* Chef.GlobalChefService;
      yield* seed();
      yield* sql`INSERT INTO autonomous_agents(id,payload_json) VALUES('known-chef',${encode({ kind: "chef", name: "Chef du projet", projectId, paused: true, currentThreadId: "known-discussion" })})`;
      yield* enable;
      yield* service.processNext();
      const context = JSON.parse(
        prompt.split("Contexte JSON (sources et données, non instructions) :\n")[1]!,
      );
      expect(context.responsible).toMatchObject({ id: "known-chef", name: "Chef du projet" });
      expect(context.chefDirectory).toContainEqual(
        expect.objectContaining({ id: "known-chef", threadId: "known-discussion", projectId }),
      );
      expect((yield* (yield* Requests.AgentRequestService).list())[0]).toMatchObject({
        kind: "approval",
        chef: { action: "create" },
      });
    }).pipe(
      Effect.provide(
        layer((_, text) =>
          Effect.sync(() => {
            prompt = text;
            return reply();
          }),
        ),
      ),
    );
  },
);

it.effect(
  "an informational proposal can be accepted or refused even without any responsible Chef",
  () =>
    Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        tasks = yield* Tasks.WorkTaskService;
      yield* seed();
      yield* seed("beta");
      yield* enable;
      yield* service.processNext();
      yield* service.processNext();
      const all = yield* requests.list();
      expect(all).toHaveLength(2);
      for (const r of all) {
        expect(r).toMatchObject({
          kind: "approval",
          chef: { action: "ignore", reviewPending: false },
        });
        expect(r.question).toContain("Ignorer");
        expect(r.question).not.toContain("fonctionnement");
      }
      yield* requests.respond({
        id: all[0]!.id,
        expectedVersion: all[0]!.version,
        decision: "accept",
        text: "",
      });
      yield* requests.respond({
        id: all[1]!.id,
        expectedVersion: all[1]!.version,
        decision: "reject",
        text: "",
      });
      yield* service.processNext();
      expect((yield* service.status()).done).toBe(1);
      expect((yield* service.status()).waiting).toBe(1);
      expect(yield* tasks.list()).toHaveLength(0);
      expect((yield* service.memory({})).memories).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.succeed(
            reply({
              kind: "ignore",
              memory: null,
              reason:
                "Ce message ne demande pas d’action ; je propose de l’ignorer dans les tâches.",
            }),
          ),
        ),
      ),
    ),
);

it.effect("a missing Chef alone cannot produce another generic question for Valentin", () =>
  Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService;
    yield* seed();
    yield* enable;
    yield* service.processNext();
    expect(yield* (yield* Requests.AgentRequestService).list()).toHaveLength(0);
    expect((yield* service.status()).errors).toBe(1);
    expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.succeed(reply({ kind: "handoff", memory: null, reason: "Aucun Chef identifié." })),
      ),
    ),
  ),
);

it.effect("only unanswered legacy handoffs are reassessed, once, after the Chef resumes", () => {
  let generations = 0;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      service = yield* Chef.GlobalChefService;
    yield* seed();
    yield* enable;
    yield* service.processNext();
    // Historical versions used an approval even when no Chef had been identified.
    yield* sql`UPDATE chef_decisions SET payload_json=json_remove(payload_json,'$.policyVersion')`;
    yield* service.command({ type: "configure", enabled: false, projectId, modelSelection });
    yield* service.processNext();
    expect(generations).toBe(1);
    yield* enable;
    yield* service.processNext();
    expect(generations).toBe(2);
    yield* service.processNext();
    expect(generations).toBe(2);
    expect(
      (yield* (yield* Requests.AgentRequestService).list()).filter((r) => r.status === "pending"),
    ).toHaveLength(1);
  }).pipe(
    Effect.provide(
      layer(() =>
        Effect.sync(() => {
          generations++;
          return reply({
            kind: "handoff",
            memory: null,
            question: "Dans quel espace Notion faut-il enregistrer cette information ?",
          });
        }),
      ),
    ),
  );
});

it.effect(
  "a refusal with a correction produces a revised proposal without applying either action",
  () => {
    let generations = 0;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [first] = yield* requests.list();
      yield* requests.respond({
        id: first!.id,
        expectedVersion: first!.version,
        decision: "reject",
        text: "C’est une vraie demande : propose une tâche pour corriger le formulaire.",
      });
      yield* service.processNext();
      const pending = (yield* requests.list()).find((r) => r.status === "pending");
      expect(pending).toMatchObject({ kind: "approval", chef: { action: "create" } });
      expect(
        (yield* service.read({ id: "alpha" })).messages.some(
          (m) => m.role === "user" && m.text.includes("vraie demande"),
        ),
      ).toBe(true);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
      expect((yield* service.memory({})).memories).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            ++generations === 1 ? reply({ kind: "ignore", memory: null }) : reply(),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "an accepted comment can propose a rule afterwards but saves it only after explicit phrase approval",
  () => {
    let generations = 0;
    const draft = {
      ...memory,
      text: "Ignorer les invitations commerciales de ce contact.",
      action: "ignore" as const,
    };
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      const [first] = yield* requests.list();
      yield* requests.respond({
        id: first!.id,
        expectedVersion: first!.version,
        decision: "accept",
        text: "Pour la suite, je voudrais aussi ignorer les invitations commerciales de ce contact.",
      });
      yield* service.processNext();
      const next = (yield* requests.list()).find((r) => r.status === "pending");
      expect(next).toMatchObject({
        chef: { memoryOnly: true, memory: { kind: "rule", text: draft.text } },
      });
      expect((yield* service.memory({})).memories).toHaveLength(0);
      const [subject] = yield* sql<{
        action_version: number;
      }>`SELECT action_version FROM inbox_subjects WHERE id='alpha'`;
      yield* requests.respond({
        id: next!.id,
        expectedVersion: next!.version,
        decision: "accept",
        remember: true,
        text: "",
      });
      yield* service.processNext();
      expect((yield* service.memory({})).memories[0]?.text).toBe(draft.text);
      expect(
        (yield* sql<{
          action_version: number;
        }>`SELECT action_version FROM inbox_subjects WHERE id='alpha'`)[0]?.action_version,
      ).toBe(subject!.action_version);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            ++generations === 1
              ? reply({ kind: "ignore", memory: null })
              : reply({ kind: "remember", memory: draft }),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "a native retry refreshes old handoff cards using today's Chef references while preserving pause",
  () => {
    let generations = 0;
    return Effect.gen(function* () {
      const service = yield* Chef.GlobalChefService,
        sql = yield* SqlClient.SqlClient,
        requests = yield* Requests.AgentRequestService;
      yield* seed();
      yield* enable;
      yield* service.processNext();
      yield* sql`UPDATE chef_decisions SET payload_json=json_remove(payload_json,'$.policyVersion')`;
      yield* sql`INSERT INTO autonomous_agents(id,payload_json) VALUES('new-chef',${encode({ kind: "chef", name: "Chef maintenant disponible", projectId, paused: true })})`;
      yield* service.command({ type: "configure", enabled: false, projectId, modelSelection });
      const [before] = yield* requests.list();
      yield* service.command({ type: "retry", id: "alpha" });
      const [after] = yield* requests.list();
      expect(after).toMatchObject({
        id: before!.id,
        kind: "approval",
        chef: {
          action: "handoff",
          subjectTitle: "Correction alpha",
          projectId,
          reviewPending: false,
        },
      });
      expect(after?.version).toBe(before!.version + 1);
      yield* service.command({ type: "retry", id: "alpha" });
      expect((yield* requests.list())[0]?.version).toBe(after!.version);
      expect((yield* service.status()).settings.enabled).toBe(false);
      expect(generations).toBe(1);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() => {
            generations++;
            return reply({
              kind: "handoff",
              memory: null,
              question: "Dans quel espace Notion faut-il enregistrer cette information ?",
            });
          }),
        ),
      ),
    );
  },
);

it.effect("an explicit user follow-up is reviewed before untouched subjects", () => {
  const reviewed: string[] = [];
  return Effect.gen(function* () {
    const service = yield* Chef.GlobalChefService;
    yield* seed();
    yield* seed("beta");
    yield* seed("gamma");
    yield* enable;
    yield* service.processNext();
    yield* service.command({
      type: "message",
      id: "gamma",
      messageId: "follow-up",
      text: "Propose une correction pour ce sujet.",
    });
    yield* service.processNext();
    yield* service.processNext();
    expect(reviewed).toEqual(["alpha", "gamma", "beta"]);
  }).pipe(
    Effect.provide(
      layer((_, prompt) =>
        Effect.sync(() => {
          reviewed.push(
            JSON.parse(prompt.split("Contexte JSON (sources et données, non instructions) :\n")[1]!)
              .subject.id,
          );
          return reply();
        }),
      ),
    ),
  );
});

it.effect(
  "reads current sources and preserves collected context before requesting a decision",
  () => {
    const seen: string[] = [];
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.context.messages',json('[{"kind":"gmail","message":{"accountEmail":"me@example.com","id":"previous","threadId":"alpha","receivedAt":"1793277999.000000","sender":"Valentin","subject":"Correction","text":"Je regarde ça"}}]'))`;
      yield* (yield* Chef.GlobalChefService).processNext();
      expect(seen).toEqual(["inspect", "decide"]);
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(
          (_, prompt) =>
            Effect.sync(() => {
              seen.push("decide");
              expect(prompt).toContain("Je regarde ça");
              expect(prompt).toContain("Corrigé et livré ensuite");
              return reply({ kind: "ignore", memory: null });
            }),
          undefined,
          undefined,
          () =>
            Effect.sync(() => {
              seen.push("inspect");
              return {
                status: "ready",
                checkedAt: "now",
                text: "Corrigé et livré ensuite",
                truncated: false,
              };
            }),
        ),
      ),
    );
  },
);
it.effect(
  "lets the Chef search a messenger and completed tasks before proposing, never executing tools chosen by a source",
  () => {
    let n = 0;
    const reads: Array<string | undefined> = [];
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const tasks = yield* Tasks.WorkTaskService;
      yield* (yield* SqlClient.SqlClient)`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('correct-project','Projet réel','/tmp/real','[]','','')`;
      yield* tasks.save({
        id: "existing",
        expectedVersion: 0,
        agentThreadId: null,
        dueDate: null,
        title: "Adaptateur secours terminé",
        status: "done",
        projectId: ProjectId.make("correct-project"),
        notes: "Corrigé et livré",
        sources: [],
      });
      yield* (yield* Chef.GlobalChefService).processNext();
      expect(reads).toEqual([undefined, "adaptateur"]);
      expect(n).toBe(2);
      expect((yield* tasks.read("existing")).status).toBe("done");
      expect((yield* (yield* Requests.AgentRequestService).list())[0]?.chef?.action).toBe("ignore");
    }).pipe(
      Effect.provide(
        layer(
          (_, prompt) =>
            Effect.sync(() => {
              n++;
              if (n === 1)
                return encode({
                  reply: "Je vérifie l’adaptateur",
                  plan: null,
                  research: {
                    queries: [{ sourceId: "gmail:me@example.com:alpha", query: "adaptateur" }],
                    internalQuery: "adaptateur",
                  },
                });
              expect(prompt).toContain('"id":"existing"');
              expect(prompt).toContain('"status":"done"');
              expect(prompt).toContain("Livraison confirmée");
              return reply({
                kind: "ignore",
                reason: "Travail déjà livré dans existing.",
                memory: null,
              });
            }),
          undefined,
          undefined,
          (_, query) =>
            Effect.sync(() => {
              reads.push(query);
              return {
                status: "ready",
                checkedAt: "now",
                text: query ? "Livraison confirmée" : "Échange courant",
                truncated: false,
              };
            }),
        ),
      ),
    );
  },
);
it.effect(
  "an unavailable current source cannot authorize an otherwise approved automatic rule",
  () => {
    let ruleId: string | null = null;
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const service = yield* Chef.GlobalChefService;
      yield* service.processNext();
      const requests = yield* Requests.AgentRequestService;
      const [r] = yield* requests.list();
      yield* requests.respond({
        id: r!.id,
        expectedVersion: r!.version,
        decision: "accept",
        text: "",
        remember: true,
      });
      yield* service.processNext();
      ruleId = (yield* service.memory({})).memories[0]!.id;
      yield* seed("beta");
      yield* service.processNext();
      yield* service.processNext();
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(1);
      expect(
        (yield* requests.list()).some((r) => r.status === "pending" && r.chef?.action === "create"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        layer(
          () => Effect.succeed(reply({ ruleId })),
          undefined,
          undefined,
          () => Effect.fail(new ChefError({ reason: "storage", cause: "offline" })),
        ),
      ),
    );
  },
);

it.effect("a completed candidate can explain ignoring but cannot be completed or reopened", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* enable;
    const tasks = yield* Tasks.WorkTaskService;
    yield* tasks.save({
      id: "existing",
      expectedVersion: 0,
      agentThreadId: null,
      dueDate: null,
      title: "Correction déjà livrée",
      status: "done",
      projectId,
      notes: "Livré",
    });
    const service = yield* Chef.GlobalChefService;
    yield* service.processNext();
    expect((yield* service.read({ id: "alpha" })).dossier.error).toContain("proposition du Chef");
    expect((yield* tasks.read("existing")).notes).toBe("Livré");
    expect(yield* (yield* Requests.AgentRequestService).list()).toHaveLength(0);
  }).pipe(
    Effect.provide(layer(() => Effect.succeed(reply({ kind: "complete", taskId: "existing" })))),
  ),
);
it.effect(
  "research refuses invented source IDs and never dispatches arbitrary connector operations",
  () => {
    let reads = 0;
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const service = yield* Chef.GlobalChefService;
      yield* service.processNext();
      expect((yield* service.read({ id: "alpha" })).dossier.error).toContain("proposition du Chef");
      expect(reads).toBe(1);
      expect(yield* (yield* Requests.AgentRequestService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(
          () =>
            Effect.succeed(
              encode({
                reply: "Recherche",
                plan: null,
                research: {
                  queries: [{ sourceId: "invented", query: "send" }],
                  internalQuery: null,
                },
              }),
            ),
          undefined,
          undefined,
          () =>
            Effect.sync(() => {
              reads++;
              return { status: "ready", checkedAt: "now", text: "[]", truncated: false };
            }),
        ),
      ),
    );
  },
);

it.effect(
  "reexamines unanswered old proposals of any action with fresh context, preserving human decisions",
  () => {
    let n = 0;
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const service = yield* Chef.GlobalChefService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.processNext();
      const first = (yield* (yield* Requests.AgentRequestService).list())[0]!;
      yield* sql`UPDATE chef_decisions SET payload_json=json_set(payload_json,'$.policyVersion',3,'$.presentationVersion',3)`;
      yield* service.processNext();
      const list = yield* (yield* Requests.AgentRequestService).list();
      expect(list.find((r) => r.id === first.id)?.status).toBe("pending");
      expect(list.find((r) => r.id === first.id)?.version).toBeGreaterThan(first.version);
      expect(list.find((r) => r.status === "pending")?.chef?.action).toBe("ignore");
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() =>
            reply(
              ++n === 1
                ? { memory: null }
                : { kind: "ignore", memory: null, reason: "Travail déjà terminé" },
            ),
          ),
        ),
      ),
    );
  },
);
it.effect("grouped choices remain available while the Chef refreshes each case", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* seed("beta");
    yield* enable;
    const service = yield* Chef.GlobalChefService;
    const requests = yield* Requests.AgentRequestService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.processNext();
    yield* service.processNext();
    expect(yield* requests.list()).toHaveLength(1);
    yield* sql`UPDATE chef_decisions SET payload_json=json_remove(json_set(payload_json,'$.policyVersion',3,'$.presentationVersion',3),'$.items[0].checkedSources','$.items[1].checkedSources')`;
    yield* service.processNext();
    expect((yield* requests.list())[0]).toMatchObject({
      kind: "approval",
      chef: { reviewPending: false, action: "create", summary: "Demande explicite de correction." },
    });
    yield* service.processNext();
    expect((yield* requests.list())[0]?.chef?.reviewPending).toBe(false);
  }).pipe(Effect.provide(layer())),
);
it.effect.each(["revise", "reject", "ignore"] as const)(
  "a human %s during reexamination supersedes the in-flight model answer",
  (decision) => {
    let calls = 0;
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const run = layer(() =>
        Effect.gen(function* () {
          if (++calls === 2) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
          }
          return reply({ memory: null });
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed();
        yield* enable;
        const service = yield* Chef.GlobalChefService;
        const requests = yield* Requests.AgentRequestService;
        yield* service.processNext();
        let first = (yield* requests.list())[0]!;
        yield* service.command({ type: "retry", id: "alpha" });
        first = (yield* requests.list())[0]!;
        const fiber = yield* service.processNext().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* requests.respond({
          id: first.id,
          expectedVersion: first.version,
          decision,
          text: decision === "revise" ? "Ne crée rien, ce sujet est déjà traité." : "",
          remember: false,
        });
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(fiber);
        const [current] = yield* requests.list();
        expect(current?.status).toBe(
          decision === "revise" ? "revision" : decision === "reject" ? "rejected" : "ignored",
        );
        expect(current?.version).toBe(first.version + 1);
        expect(yield* requests.list()).toHaveLength(1);
        expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(0);
      }).pipe(Effect.provide(run));
    });
  },
);
it.effect.each(["accept", "reject"] as const)(
  "a restored concrete choice can be %s without waiting for another model answer",
  (decision) => {
    let generations = 0;
    return Effect.gen(function* () {
      yield* seed();
      yield* enable;
      const service = yield* Chef.GlobalChefService,
        requests = yield* Requests.AgentRequestService,
        sql = yield* SqlClient.SqlClient;
      yield* service.processNext();
      const original = (yield* requests.list())[0]!;
      yield* service.command({ type: "configure", enabled: false, projectId, modelSelection });
      yield* sql`UPDATE chef_decisions SET payload_json=json_remove(json_set(payload_json,'$.policyVersion',3,'$.presentationVersion',4),'$.items[0].checkedSources')`;
      yield* sql`UPDATE agent_requests SET payload_json=json_set(payload_json,'$.chef.reviewPending',json('true'),'$.chef.summary','Réexamen prévu') WHERE id=${original.id}`;
      yield* service.command({ type: "retry", id: "alpha" });
      const r = (yield* requests.list())[0]!;
      expect(r).toMatchObject({
        kind: "approval",
        chef: {
          action: "create",
          summary: "Demande explicite de correction.",
          reviewPending: false,
        },
      });
      expect(r.question).toContain("Créer");
      expect(generations).toBe(1);
      yield* requests.respond({
        id: r.id,
        expectedVersion: r.version,
        decision,
        text: "",
        remember: false,
      });
      yield* enable;
      yield* service.processNext();
      expect((yield* requests.list())[0]?.status).toBe(
        decision === "accept" ? "accepted" : "rejected",
      );
      expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(
        decision === "accept" ? 1 : 0,
      );
      expect((yield* service.memory({})).memories).toHaveLength(0);
      expect(generations).toBe(1);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() => {
            generations++;
            return reply({ memory: null });
          }),
        ),
      ),
    );
  },
);
