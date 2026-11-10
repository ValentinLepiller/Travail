import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as Tasks from "../workTasks/WorkTaskService.ts";
import * as Inbox from "./MessageInbox.ts";
import * as Subjects from "./InboxSubjectService.ts";
import * as Actions from "./InboxSubjectActions.ts";
import * as Model from "./InboxSubjectModel.ts";

const result = (kind = "task", id: string | null = "target") =>
  JSON.stringify({
    kind,
    id,
    reason: "Correspond exactement à la demande existante.",
    uncertain: false,
  });
const layer = (
  generate: Model.InboxSubjectModel["Service"]["generate"] = () => Effect.succeed(result()),
) =>
  Actions.layer.pipe(
    Layer.provideMerge(
      Subjects.layer.pipe(Layer.provide(Layer.succeed(Model.InboxSubjectModel, { generate }))),
    ),
    Layer.provideMerge(Tasks.layer),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "subject-context-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const seed = (id = "new") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Projet Alpha','/tmp/alpha','[]','','') ON CONFLICT DO NOTHING`;
    const inbox = yield* Inbox.MessageInbox;
    yield* inbox.ingestGmail({
      accountEmail: "me@example.com",
      id,
      threadId: id,
      receivedAt: "1793278000.000001",
      sender: "Client",
      subject: "Incident Alpha",
      text: "Précision sur la même demande",
    });
    yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at) VALUES(${id},${id},'Une précision utile','')`;
    yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES(${`gmail:me@example.com:${id}`},${id},'','{}')`;
    const queue = yield* Subjects.InboxSubjectService;
    yield* queue.setEnabled(true);
    return queue;
  });
const target = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('existing-thread','project','Discussion existante','codex','full-access','default','','','{}')`;
  return yield* (yield* Tasks.WorkTaskService).save({
    id: "target",
    expectedVersion: 0,
    title: "Tâche originale",
    notes: "Notes initiales",
    status: "doing",
    projectId: ProjectId.make("project"),
    agentThreadId: ThreadId.make("existing-thread"),
    dueDate: "2026-12-01",
  });
});

it.effect(
  "Luna assigns an exact existing task without editing it or treating the new subject",
  () =>
    Effect.gen(function* () {
      const queue = yield* seed(),
        tasks = yield* Tasks.WorkTaskService;
      const original = yield* target;
      yield* queue.processContextNext();
      const subject = (yield* queue.list({})).subjects[0]!;
      expect(subject.context).toEqual({ kind: "task", id: original.id, projectId: "project" });
      expect(subject.contextLabel).toBe(original.title);
      expect(subject.processed).toBe(false);
      expect(subject.taskId).toBeNull();
      expect(subject.contextUpdatedAt).toBeTruthy();
      expect(yield* tasks.read(original.id)).toEqual(original);
      yield* queue.processContextNext();
      expect((yield* queue.status()).contextsPending).toBe(0);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "completing a task appends notes and sources, preserves its discussion and replays exactly once",
  () =>
    Effect.gen(function* () {
      const queue = yield* seed(),
        tasks = yield* Tasks.WorkTaskService,
        actions = yield* Actions.InboxSubjectActions,
        sql = yield* SqlClient.SqlClient;
      const original = yield* target;
      yield* queue.processContextNext();
      const s = (yield* queue.list({})).subjects[0]!;
      const input = {
        kind: "complete" as const,
        subjectId: s.id,
        expectedVersion: s.actionVersion!,
        requestId: "complete",
        taskId: original.id,
        taskVersion: original.version,
        description: "Nouvelle information validée",
      };
      const saved = yield* actions.apply(input);
      expect(yield* actions.apply(input)).toEqual(saved);
      const updated = yield* tasks.read(original.id);
      expect(updated).toMatchObject({
        title: original.title,
        projectId: original.projectId,
        agentThreadId: original.agentThreadId,
        status: original.status,
        dueDate: original.dueDate,
        version: original.version + 1,
        automationMode: "manual",
      });
      expect(updated.notes).toContain(original.notes);
      expect(updated.notes).toContain(input.description);
      expect(updated.inboxSubjectIds).toEqual([s.id]);
      expect(updated.sources).toHaveLength(2);
      expect((yield* queue.list({})).subjects[0]).toMatchObject({
        taskId: original.id,
        taskLinkKind: "completed",
        processed: true,
        title: s.title,
      });
      expect(yield* sql`SELECT sequence FROM orchestration_events`).toEqual([]);
      expect(yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).toEqual([
        { thread_id: "existing-thread" },
      ]);
      const unrelated = yield* tasks.save({ ...original, id: "different", expectedVersion: 0 });
      expect(
        (yield* actions
          .apply({
            ...input,
            requestId: "different",
            taskId: unrelated.id,
            taskVersion: unrelated.version,
            expectedVersion: saved.actionVersion,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("linked");
    }).pipe(Effect.provide(layer())),
);

it.effect.each(["project", "chantier"] as const)(
  "routes to %s and lets a human create a separate task with the selected chantier",
  (kind) =>
    Effect.gen(function* () {
      const queue = yield* seed(),
        tasks = yield* Tasks.WorkTaskService,
        actions = yield* Actions.InboxSubjectActions;
      yield* tasks.saveChantier({
        id: "chantier",
        expectedVersion: 0,
        title: "Incident Alpha",
        projectId: ProjectId.make("project"),
        status: "active",
        objective: "Résoudre Alpha",
        scope: "Même incident",
        decisions: "",
        sources: [],
        targetPeriod: "",
        externalDependencies: [],
      });
      yield* queue.processContextNext();
      const s = (yield* queue.list({})).subjects[0]!;
      expect(s.context?.kind).toBe(kind);
      const saved = yield* actions.apply({
        kind: "create",
        subjectId: s.id,
        requestId: "create",
        expectedVersion: s.actionVersion!,
        title: "Action humaine",
        description: "Description revue",
        projectId: ProjectId.make("project"),
      });
      expect(yield* tasks.read(saved.taskId!)).toMatchObject({
        status: "ready",
        automationMode: "manual",
        projectId: "project",
        chantierId: kind === "chantier" ? "chantier" : null,
      });
    }).pipe(
      Effect.provide(
        layer(() => Effect.succeed(result(kind, kind === "project" ? "project" : "chantier"))),
      ),
    ),
);

it.effect("a human cannot create in a chantier that has since finished", () =>
  Effect.gen(function* () {
    const q = yield* seed(),
      tasks = yield* Tasks.WorkTaskService;
    yield* tasks.saveChantier({
      id: "closed",
      expectedVersion: 0,
      title: "Terminé",
      projectId: ProjectId.make("project"),
      status: "done",
      objective: "x",
      scope: "x",
      decisions: "",
      sources: [],
      targetPeriod: "",
      externalDependencies: [],
    });
    const error = yield* (yield* Actions.InboxSubjectActions)
      .apply({
        kind: "create",
        requestId: "closed-chantier",
        subjectId: "new",
        expectedVersion: 0,
        title: "Action",
        description: "Description",
        projectId: ProjectId.make("project"),
        chantierId: "closed",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("project");
    expect(yield* tasks.list()).toEqual([]);
    expect((yield* q.list({})).subjects[0]!.processed).toBe(false);
  }).pipe(Effect.provide(layer())),
);

it.effect("a personal subject can explicitly have no project or task", () =>
  Effect.gen(function* () {
    const q = yield* seed();
    yield* q.processContextNext();
    expect((yield* q.list({})).subjects[0]).toMatchObject({
      context: null,
      contextUncertain: false,
    });
    expect((yield* q.status()).contextsPending).toBe(0);
  }).pipe(Effect.provide(layer(() => Effect.succeed(result("none", null))))),
);

it.effect.each(["unknown-id", "finished", "in-chantier"])(
  "rejects an unavailable task destination %s without changing sources",
  (id) =>
    Effect.gen(function* () {
      const q = yield* seed(),
        tasks = yield* Tasks.WorkTaskService;
      if (id === "finished")
        yield* tasks.save({ ...(yield* target), status: "done", expectedVersion: 1, id: "target" });
      if (id === "in-chantier") {
        yield* tasks.saveChantier({
          id: "c",
          expectedVersion: 0,
          title: "Scope",
          projectId: ProjectId.make("project"),
          status: "active",
          objective: "x",
          scope: "x",
          decisions: "",
          sources: [],
          targetPeriod: "",
          externalDependencies: [],
        });
        yield* tasks.save({
          id,
          expectedVersion: 0,
          title: "Task",
          notes: "",
          status: "ready",
          projectId: ProjectId.make("project"),
          chantierId: "c",
          agentThreadId: null,
          dueDate: null,
        });
      }
      yield* q.processContextNext();
      expect((yield* q.list({})).subjects[0]).toMatchObject({
        context: null,
        contextError: "format",
        processed: false,
      });
      expect((yield* q.status()).contextErrors).toBe(1);
    }).pipe(
      Effect.provide(
        layer(() => Effect.succeed(result("task", id === "finished" ? "target" : id))),
      ),
    ),
);

it.effect("a task completed while Luna answers cannot become the context", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>(),
      reply = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const q = yield* seed(),
        tasks = yield* Tasks.WorkTaskService;
      const t = yield* target;
      const fiber = yield* q.processContextNext().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* tasks.save({ ...t, status: "done", expectedVersion: t.version });
      yield* Deferred.succeed(reply, result());
      yield* Fiber.join(fiber);
      expect((yield* q.list({})).subjects[0]).toMatchObject({
        context: null,
        contextError: "stale",
      });
    }).pipe(
      Effect.provide(
        layer(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
        ),
      ),
    );
  }),
);

it.effect("does not classify closed or ignored subjects, or run when paused", () =>
  Effect.gen(function* () {
    let calls = 0;
    yield* Effect.gen(function* () {
      const q = yield* seed("closed"),
        sql = yield* SqlClient.SqlClient;
      yield* seed("ignored");
      yield* sql`UPDATE inbox_subjects SET closed_at='2026-11-10' WHERE id='closed'`;
      yield* sql`UPDATE inbox_subjects SET ignored=1 WHERE id='ignored'`;
      yield* q.processContextNext();
      expect(calls).toBe(0);
      yield* seed("open");
      yield* q.setEnabled(false);
      yield* q.processContextNext();
      expect(calls).toBe(0);
      yield* q.setEnabled(true);
      yield* q.processContextNext();
      expect(calls).toBe(1);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.sync(() => {
            calls++;
            return result("none", null);
          }),
        ),
      ),
    );
  }),
);

it.effect.each(["enable", "timer"] as const)(
  "%s retries a failed context without reclassifying successful decisions",
  (method) =>
    Effect.gen(function* () {
      let ready = false,
        calls = 0;
      yield* Effect.gen(function* () {
        const q = yield* seed();
        yield* q.processContextNext();
        expect((yield* q.status()).contextErrors).toBe(1);
        yield* q.processContextNext();
        expect(calls).toBe(1);
        ready = true;
        if (method === "enable") yield* q.setEnabled(true);
        else yield* TestClock.adjust("30 seconds");
        yield* q.processContextNext();
        expect((yield* q.status()).contextsPending).toBe(0);
        expect(calls).toBe(2);
        const success = (yield* q.list({})).subjects[0];
        yield* q.setEnabled(true);
        yield* q.processContextNext();
        expect(calls).toBe(2);
        expect((yield* q.list({})).subjects[0]).toEqual(success);
      }).pipe(
        Effect.provide(
          layer(() =>
            Effect.suspend(() => {
              calls++;
              return ready
                ? Effect.succeed(result("none", null))
                : Effect.fail(new Model.SubjectModelError({ reason: "configuration" }));
            }),
          ),
        ),
      );
    }),
);

it.effect("a human choice made during classification wins over Luna's pending answer", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>(),
      reply = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const q = yield* seed(),
        actions = yield* Actions.InboxSubjectActions;
      const fiber = yield* q.processContextNext().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const saved = yield* actions.apply({
        kind: "create",
        requestId: "human",
        subjectId: "new",
        expectedVersion: 0,
        title: "Choix humain",
        description: "Notes",
        projectId: null,
      });
      yield* Deferred.succeed(reply, result("project", "project"));
      yield* Fiber.join(fiber);
      expect((yield* q.list({})).subjects[0]).toMatchObject({
        taskId: saved.taskId,
        context: null,
        contextReason: "Choix confirmé lors de l’action humaine.",
      });
      expect((yield* q.status()).contextsPending).toBe(0);
    }).pipe(
      Effect.provide(
        layer(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
        ),
      ),
    );
  }),
);

it.effect("a new entry arriving during classification remains to be contextualized", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>(),
      reply = yield* Deferred.make<string>();
    let calls = 0;
    yield* Effect.gen(function* () {
      const q = yield* seed(),
        sql = yield* SqlClient.SqlClient;
      const fiber = yield* q.processContextNext().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* (yield* Inbox.MessageInbox).ingestGmail({
        accountEmail: "me@example.com",
        id: "later",
        threadId: "new",
        receivedAt: "1793278001.000001",
        sender: "Client",
        subject: "Précision",
        text: "Autre précision",
      });
      yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES('gmail:me@example.com:later','new','','{}')`;
      yield* Deferred.succeed(reply, result("none", null));
      yield* Fiber.join(fiber);
      expect((yield* q.status()).contextsPending).toBe(1);
      yield* q.processContextNext();
      expect((yield* q.status()).contextsPending).toBe(0);
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        layer(() =>
          Effect.suspend(() => {
            calls++;
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply)));
          }),
        ),
      ),
    );
  }),
);
