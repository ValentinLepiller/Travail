import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ThreadId, ProjectId, type InboxSubjectActionInput } from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as Tasks from "../workTasks/WorkTaskService.ts";
import * as Actions from "./InboxSubjectActions.ts";
import * as Inbox from "./MessageInbox.ts";
import * as Subjects from "./InboxSubjectService.ts";
import * as Model from "./InboxSubjectModel.ts";

const layer = (
  db: ReturnType<typeof Sqlite.layerFromPath> = Sqlite.layerMemory,
  generate: Model.InboxSubjectModel["Service"]["generate"] = () =>
    Effect.die("No model is available to manual actions"),
) =>
  Actions.layer.pipe(
    Layer.provideMerge(Tasks.layer),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(
      Subjects.layer.pipe(
        Layer.provide(
          Layer.succeed(Model.InboxSubjectModel, {
            generate,
          }),
        ),
      ),
    ),
    Layer.provideMerge(db),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "manual-inbox-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const seed = (id = "alpha") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inbox = yield* Inbox.MessageInbox;
    yield* inbox.ingestGmail({
      accountEmail: "me@example.com",
      id,
      threadId: id,
      receivedAt: "1793278000.000001",
      sender: "Client",
      subject: id,
      text: `Original ${id}`,
    });
    yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at) VALUES(${id},${id},'Résumé humain initial','')`;
    yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json)
    VALUES(${`gmail:me@example.com:${id}`},${id},'','{}')`;
  });
const create = (
  extra: Partial<Extract<InboxSubjectActionInput, { kind: "create" }>> = {},
): InboxSubjectActionInput => ({
  kind: "create",
  subjectId: "alpha",
  requestId: "create-alpha",
  expectedVersion: 0,
  title: "Titre révisé",
  description: "Description validée",
  projectId: null,
  ...extra,
});

it.effect(
  "creates one real manual task on concurrent replay, conserves originals and rejects stale/reused requests",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      const before = yield* sql`SELECT * FROM message_inbox`;
      const results = yield* Effect.all([actions.apply(create()), actions.apply(create())], {
        concurrency: 2,
      });
      expect(results[0]).toEqual(results[1]);
      const task = (yield* tasks.list())[0]!;
      expect(yield* tasks.list()).toHaveLength(1);
      expect(task).toMatchObject({
        title: "Titre révisé",
        notes: "Description validée",
        status: "todo",
        automationMode: "manual",
        agentThreadId: null,
        inboxSubjectIds: ["alpha"],
        version: 1,
      });
      expect(task.sources?.[0]?.url).toContain("mail.google.com");
      expect(yield* sql`SELECT * FROM message_inbox`).toEqual(before);
      expect(yield* sql`SELECT * FROM inbox_subject_task_sources`).toHaveLength(1);
      expect(yield* actions.apply(create({ title: "Changed" })).pipe(Effect.flip)).toMatchObject({
        reason: "conflict",
      });
      expect(
        yield* actions.apply(create({ requestId: "new-attempt" })).pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
      expect(
        yield* actions
          .apply(create({ requestId: "duplicate-create", expectedVersion: 1 }))
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "linked" });
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "accepts Sans projet even when projects exist and rejects invalid text or unavailable project references",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Projet','/tmp/project','[]','','')`;
      expect(
        yield* actions.apply(create({ projectId: ProjectId.make("missing") })).pipe(Effect.flip),
      ).toMatchObject({ reason: "project" });
      expect(yield* actions.apply(create({ title: " " })).pipe(Effect.flip)).toMatchObject({
        _tag: "InboxSubjectActionError",
      });
      expect(yield* sql`SELECT * FROM work_tasks`).toHaveLength(0);
      const created = yield* actions.apply(create());
      expect((yield* (yield* Tasks.WorkTaskService).read(created.taskId!)).projectId).toBeNull();
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "appends reviewed notes from several subjects while preserving the native task, and refuses project/version mismatches atomically",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* seed("beta");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Projet','/tmp/project','[]','','')`;
      const chantier = yield* tasks.saveChantier({
        id: "chantier",
        title: "Chantier",
        projectId: ProjectId.make("project"),
        status: "paused",
        objective: "Objectif",
        scope: "Cadre",
        decisions: "Décisions",
        targetPeriod: "",
        sources: [],
        externalDependencies: [{ id: "external", title: "Attente", owner: "Autre", done: false }],
        expectedVersion: 0,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('worker','project','Worker','codex','approval-required','default','','','{}')`;
      yield* tasks.save({
        id: "dependency",
        title: "Dépendance",
        notes: "",
        status: "done",
        projectId: chantier.projectId,
        agentThreadId: null,
        chantierId: chantier.id,
        dueDate: null,
        expectedVersion: 0,
      });
      let task = yield* tasks.save({
        id: "existing",
        title: "Existant",
        notes: "Notes manuelles intouchées",
        status: "review",
        projectId: chantier.projectId,
        agentThreadId: ThreadId.make("worker"),
        dueDate: "2026-12-01",
        expectedVersion: 0,
        chantierId: chantier.id,
        dependsOn: ["dependency"],
        milestone: "Lot",
        acceptanceCriteria: "Critères",
        externalDependsOn: ["external"],
        sources: [{ kind: "manual", label: "Ancienne source", url: null }],
      });
      const attachments = JSON.stringify([
        {
          type: "image",
          id: "stored-image",
          name: "Contexte.png",
          mimeType: "image/png",
          sizeBytes: 12,
        },
      ]);
      yield* sql`UPDATE work_tasks SET payload_json=json_set(payload_json,'$.attachments',json(${attachments})) WHERE id=${task.id}`;
      task = yield* tasks.read(task.id);
      const update: InboxSubjectActionInput = {
        kind: "update",
        subjectId: "alpha",
        expectedVersion: 0,
        requestId: "update-alpha",
        taskId: task.id,
        taskVersion: task.version,
        projectId: task.projectId,
        title: task.title,
        description: "Précision revue",
      };
      expect(yield* actions.apply({ ...update, projectId: null }).pipe(Effect.flip)).toMatchObject({
        reason: "project",
      });
      expect(yield* actions.apply({ ...update, taskVersion: 0 }).pipe(Effect.flip)).toMatchObject({
        reason: "conflict",
      });
      expect(yield* tasks.read(task.id)).toEqual(task);
      yield* actions.apply(update);
      const first = yield* tasks.read(task.id);
      expect(first.notes).toBe(
        "Notes manuelles intouchées\n\nSujet Inbox : alpha\nPrécision revue",
      );
      for (const key of [
        "status",
        "projectId",
        "agentThreadId",
        "chantierId",
        "milestone",
        "acceptanceCriteria",
        "externalDependsOn",
        "dependsOn",
        "attachments",
        "dueDate",
        "createdAt",
      ] as const)
        expect(first[key]).toEqual(task[key]);
      expect(first.sources).toContainEqual(task.sources![0]);
      expect(yield* tasks.readChantier(chantier.id)).toEqual(chantier);
      yield* actions.apply({
        ...update,
        subjectId: "beta",
        requestId: "update-beta",
        taskVersion: first.version,
        description: "Autre sujet",
      });
      const second = yield* tasks.read(task.id);
      expect(second.inboxSubjectIds).toEqual(["alpha", "beta"]);
      expect(second.sources).toHaveLength(3);
      yield* actions.apply(update);
      expect(yield* tasks.read(task.id)).toEqual(second);
      expect(yield* sql`SELECT * FROM inbox_subject_actions`).toHaveLength(2);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "rolls back links, receipts and decisions when native chantier validation refuses the update",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      const task = yield* tasks.save({
        id: "corrupt",
        title: "Existant",
        notes: "Original",
        status: "todo",
        projectId: null,
        agentThreadId: null,
        dueDate: null,
        expectedVersion: 0,
      });
      yield* sql`UPDATE work_tasks SET payload_json=json_set(payload_json,'$.chantierId','unavailable') WHERE id=${task.id}`;
      const before = yield* tasks.read(task.id);
      expect(
        yield* actions
          .apply({
            kind: "update",
            subjectId: "alpha",
            expectedVersion: 0,
            requestId: "refused",
            taskId: task.id,
            taskVersion: task.version,
            projectId: null,
            title: "Révision",
            description: "Texte",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "WorkTaskError", reason: "project" });
      expect(yield* tasks.read(task.id)).toEqual(before);
      expect(yield* sql`SELECT * FROM inbox_subject_actions`).toHaveLength(0);
      expect(yield* sql`SELECT * FROM inbox_subject_task_sources`).toHaveLength(0);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "persists ignore, restore, task links and replay across a database reopen without discarding entries",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const db = Sqlite.layerFromPath(`${dir}/fixture.sqlite`);
      yield* Effect.gen(function* () {
        yield* seed();
        const actions = yield* Actions.InboxSubjectActions;
        yield* actions.apply(create());
        yield* actions.apply({
          kind: "ignore",
          requestId: "ignore",
          subjectId: "alpha",
          expectedVersion: 1,
          ignored: true,
        });
      }).pipe(Effect.provide(layer(db)));
      yield* Effect.gen(function* () {
        const actions = yield* Actions.InboxSubjectActions,
          subjects = yield* Subjects.InboxSubjectService;
        expect((yield* subjects.list({})).subjects[0]).toMatchObject({
          ignored: true,
          actionVersion: 2,
          taskId: expect.stringMatching(/^inbox-subject:/),
          entries: 1,
        });
        expect((yield* subjects.entries({ subjectId: "alpha" })).messages).toHaveLength(1);
        yield* actions.apply({
          kind: "ignore",
          requestId: "restore",
          subjectId: "alpha",
          expectedVersion: 2,
          ignored: false,
        });
        expect((yield* subjects.list({})).subjects[0]).toMatchObject({
          ignored: false,
          taskId: expect.stringMatching(/^inbox-subject:/),
        });
        yield* actions.apply(create());
        expect(yield* (yield* Tasks.WorkTaskService).list()).toHaveLength(1);
      }).pipe(Effect.provide(layer(db)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "ignored and linked subjects continue receiving Luna entries without automatically updating their task",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox,
        actions = yield* Actions.InboxSubjectActions;
      const subjects = yield* Subjects.InboxSubjectService,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* actions.apply(create());
      const original = (yield* tasks.list())[0]!;
      yield* actions.apply({
        kind: "ignore",
        requestId: "ignore-alpha",
        subjectId: "alpha",
        expectedVersion: 1,
        ignored: true,
      });
      yield* inbox.ingestGmail({
        accountEmail: "me@example.com",
        id: "later",
        threadId: "alpha",
        receivedAt: "1793278001.000001",
        sender: "Client",
        subject: "Suite",
        text: "Nouvelle précision",
      });
      const qualification = JSON.stringify({
        version: 1,
        status: "qualified",
        category: "information",
        probabilities: {
          no_action: 0,
          information: 1,
          personal_action: 0,
          technical_action: 0,
          unsure: 0,
        },
        confidence: 1,
        model: "fixture",
        qualifiedAt: "",
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.qualification',json(${qualification})) WHERE id='gmail:me@example.com:later'`;
      yield* subjects.setEnabled(true);
      yield* subjects.processNext();
      expect((yield* subjects.list({})).subjects[0]).toMatchObject({
        ignored: true,
        taskId: original.id,
        entries: 2,
        actionVersion: 2,
      });
      expect(yield* tasks.read(original.id)).toEqual(original);
      expect((yield* subjects.entries({ subjectId: "alpha" })).messages).toHaveLength(2);
    }).pipe(
      Effect.provide(
        layer(Sqlite.layerMemory, (prompt) =>
          Effect.sync(() => {
            const input = JSON.parse(prompt.split("DONNÉES :\n")[1]!);
            expect(Object.keys(input.candidateSubjects[0]).sort()).toEqual(
              ["sequence", "id", "title", "summary", "createdAt", "entries"].sort(),
            );
            return JSON.stringify({
              subjectId: "alpha",
              title: "",
              summary: "",
              category: "information",
              uncertain: false,
              reason: "Même sujet",
            });
          }),
        ),
      ),
    ),
);

it.effect(
  "deleting a linked task releases every subject, keeps audit sources and allows recreation or another explicit target",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        tasks = yield* Tasks.WorkTaskService;
      const subjects = yield* Subjects.InboxSubjectService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      yield* seed("beta");
      const first = yield* actions.apply(create());
      const task = yield* tasks.read(first.taskId!);
      yield* actions.apply({
        kind: "update",
        subjectId: "beta",
        expectedVersion: 0,
        requestId: "link-beta",
        taskId: task.id,
        taskVersion: task.version,
        projectId: null,
        title: task.title,
        description: "Beta",
      });
      const updated = yield* tasks.read(task.id);
      yield* tasks.delete({ id: task.id, expectedVersion: updated.version });
      expect(
        (yield* subjects.list({})).subjects.map((s) => ({
          id: s.id,
          taskId: s.taskId,
          version: s.actionVersion,
        })),
      ).toEqual([
        { id: "alpha", taskId: null, version: 2 },
        { id: "beta", taskId: null, version: 2 },
      ]);
      const replay = yield* actions.apply(create());
      expect(replay).toEqual(first);
      expect(yield* tasks.list()).toHaveLength(0);
      const recreated = yield* actions.apply(create({ requestId: "recreate", expectedVersion: 2 }));
      expect(recreated.taskId).not.toBe(first.taskId);
      const next = yield* tasks.read(recreated.taskId!);
      yield* actions.apply({
        kind: "update",
        subjectId: "beta",
        expectedVersion: 2,
        requestId: "relink-beta",
        taskId: next.id,
        taskVersion: next.version,
        projectId: null,
        title: next.title,
        description: "Beta again",
      });
      expect((yield* tasks.read(next.id)).sources).toHaveLength(2);
      expect(yield* sql`SELECT * FROM inbox_subject_task_sources`).toHaveLength(4);
      expect((yield* subjects.entries({ subjectId: "alpha" })).messages).toHaveLength(1);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "a failure after native save emits no uncommitted task and a later commit reaches subscribers",
  () =>
    Effect.gen(function* () {
      const actions = yield* Actions.InboxSubjectActions,
        tasks = yield* Tasks.WorkTaskService,
        sql = yield* SqlClient.SqlClient;
      yield* seed();
      const ready = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const observed: string[][] = [];
      const subscriber = yield* tasks.subscribe().pipe(
        Stream.runForEach((items) =>
          Effect.gen(function* () {
            observed.push(items.map((task) => task.title));
            yield* Deferred.succeed(ready, undefined);
            if (items.some((task) => task.title === "Committed"))
              yield* Deferred.succeed(committed, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* sql`CREATE TRIGGER refuse_receipt BEFORE INSERT ON inbox_subject_actions BEGIN SELECT RAISE(ABORT,'fixture refusal'); END`;
      expect(
        yield* actions.apply(create({ title: "Rolled back" })).pipe(Effect.flip),
      ).toMatchObject({ reason: "storage" });
      expect(yield* tasks.list()).toHaveLength(0);
      expect(yield* sql`SELECT * FROM inbox_subject_task_sources`).toHaveLength(0);
      expect(yield* sql`SELECT action_version AS version,task_id FROM inbox_subjects`).toEqual([
        { version: 0, task_id: null },
      ]);
      yield* sql`DROP TRIGGER refuse_receipt`;
      yield* actions.apply(create({ requestId: "committed", title: "Committed" }));
      yield* Deferred.await(committed);
      yield* Fiber.interrupt(subscriber);
      expect(observed.flat()).not.toContain("Rolled back");
      expect(observed.at(-1)).toEqual(["Committed"]);
    }).pipe(Effect.provide(layer())),
);
