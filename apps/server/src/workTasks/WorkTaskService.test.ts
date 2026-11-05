import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import { EventId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as SettlementWorker from "./WorkTaskSettlementWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectId, ProviderInstanceId, ThreadId, WorkTaskSaveInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "./WorkTaskAgentService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import type { SlackTaskMessage } from "@t3tools/contracts";

const decodeInput = Schema.decodeUnknownEffect(WorkTaskSaveInput);

const message = (fields: Partial<SlackTaskMessage> = {}): SlackTaskMessage => ({
  workspaceId: "TTEST",
  channelId: "CCLIENT",
  channelName: "cotily",
  authorId: "UCLIENT",
  ts: "1793278000.000001",
  threadTs: "1793278000.000001",
  text: "Une demande client",
  ...fields,
});

it.effect(
  "qualifiers decide their own task without approval and leave preparation to the coordinator",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO autonomous_agents (id, payload_json)
      VALUES ('qualifier', '{"trigger":"unqualified"}')`;
      yield* service.ingestSlack(message({ channelId: "COTHER" }));
      const otherTask = (yield* service.list())[0]!;
      for (const status of ["todo", "rejected"] as const) {
        const threadId = ThreadId.make(`qualifier-${status}`);
        yield* service.ingestSlack(message({ channelId: `C${status.toUpperCase()}` }));
        const task = (yield* service.list()).find(
          (task) => task.id !== otherTask.id && task.status === "unqualified",
        )!;
        yield* sql`INSERT INTO autonomous_agent_runs
        (thread_id, agent_id, title, prompt, started_at, task_id)
        VALUES (${threadId}, 'qualifier', 'Qualification', '', '', ${task.id})`;
        expect(
          (yield* service
            .save({ ...otherTask, status, expectedVersion: otherTask.version }, threadId)
            .pipe(Effect.flip)).reason,
        ).toBe("conflict");
        expect(yield* service.read(otherTask.id)).toEqual(otherTask);
        const qualified = yield* service.save(
          { ...task, status, expectedVersion: task.version },
          threadId,
        );
        expect(yield* service.read(task.id)).toEqual(qualified);
        expect(qualified.status).toBe(status);
        if (status === "todo") {
          expect(qualified.qualifiedAt).toBeTruthy();
          expect(
            (yield* service
              .save({ ...qualified, status: "ready", expectedVersion: qualified.version }, threadId)
              .pipe(Effect.flip)).reason,
          ).toBe("preparation");
          expect(yield* service.read(task.id)).toEqual(qualified);
          const prepared = yield* service.save(
            { ...qualified, status: "ready", expectedVersion: qualified.version },
            ThreadId.make("coordinator-thread"),
          );
          expect((yield* service.read(task.id)).status).toBe("ready");
          expect(prepared.qualifiedAt).toBe(qualified.qualifiedAt);
        }
      }
      // Manual changes remain available without an autonomous caller.
      expect(
        (yield* service.save({ ...otherTask, status: "todo", expectedVersion: otherTask.version }))
          .status,
      ).toBe("todo");
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

const qualificationFixture = Effect.gen(function* () {
  const service = yield* Tasks.WorkTaskService;
  const sql = yield* SqlClient.SqlClient;
  for (let index = 0; index < 20; index++) {
    const ts = `17932780${String(index).padStart(2, "0")}.000001`;
    yield* service.ingestSlack(
      message({ ts, threadTs: ts, text: `${index < 15 ? "A" : "B"}${index}` }),
    );
  }
  const tasks = yield* service.list();
  const seed = tasks.find((task) => task.title.endsWith(" — A0"))!;
  const members = tasks.filter((task) => task.title.includes(" — A") && task.id !== seed.id);
  const threadId = ThreadId.make("qualifying-group");
  yield* sql`INSERT INTO autonomous_agents (id, payload_json) VALUES ('qualifier', ${JSON.stringify({ trigger: "unqualified", projectId: null, paused: false, currentThreadId: threadId })})`;
  yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id) VALUES (${threadId},'qualifier','Qualification','','',${seed.id})`;
  const input = {
    ...seed,
    title: "Demande A consolidée",
    notes: "Les quinze messages décrivent la même action.",
    status: "todo" as const,
    expectedVersion: seed.version,
    qualificationGroup: members.map(({ id, version }) => ({ id, expectedVersion: version })),
  };
  return { service, sql, tasks, seed, members, threadId, input };
});

it.effect(
  "qualifies several requests from a reserved project batch without losing their sources",
  () =>
    Effect.gen(function* () {
      const { service, tasks, seed, members, threadId, input } = yield* qualificationFixture;
      const refs = tasks.map(({ id, version }) => ({ id, expectedVersion: version }));
      expect(yield* service.reserveQualification({ tasks: refs }, threadId)).toHaveLength(20);
      expect(yield* service.reserveQualification({ tasks: refs }, threadId)).toHaveLength(20);
      const first = yield* service.save(input, threadId);
      const other = tasks.filter((task) => task.title.includes(" — B"));
      const principal = other[0]!;
      const second = yield* service.save(
        {
          ...principal,
          title: "Demande B distincte",
          status: "todo",
          expectedVersion: principal.version,
          qualificationGroup: other
            .slice(1)
            .map(({ id, version }) => ({ id, expectedVersion: version })),
        },
        threadId,
      );
      expect(first.mergedTaskIds).toEqual(expect.arrayContaining(members.map((task) => task.id)));
      expect(second.mergedTaskIds).toHaveLength(4);
      expect(yield* service.messages(seed.id)).toHaveLength(15);
      expect(yield* service.messages(principal.id)).toHaveLength(5);
      expect((yield* service.list()).filter((task) => task.status === "todo")).toHaveLength(2);
      expect((yield* service.list()).filter((task) => task.status === "unqualified")).toHaveLength(
        0,
      );
      expect(
        (yield* service
          .save({ ...second, status: "ready", expectedVersion: second.version }, threadId)
          .pipe(Effect.flip)).reason,
      ).toBe("preparation");
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect.each([
  "version",
  "reserved",
  "qualified",
  "associated",
  "project",
  "limit",
  "paused",
  "caller",
  "chantier",
] as const)("reserves a batch atomically and refuses unavailable cards (%s)", (reason) =>
  Effect.gen(function* () {
    const { service, sql, members, seed, threadId } = yield* qualificationFixture;
    const candidate = members[0]!;
    if (reason === "version")
      yield* service.save({
        ...candidate,
        notes: "Nouveau message",
        expectedVersion: candidate.version,
      });
    if (reason === "qualified")
      yield* service.save({ ...candidate, status: "todo", expectedVersion: candidate.version });
    if (reason === "associated" || reason === "chantier")
      yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, ${reason === "associated" ? "$.agentThreadId" : "$.chantierId"}, 'other') WHERE id = ${candidate.id}`;
    if (reason === "project") {
      yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.projectId', 'project-a') WHERE id = ${seed.id}`;
      yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.projectId', 'project-b') WHERE id = ${candidate.id}`;
    }
    if (reason === "reserved") {
      yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id,task_ids_json,finished_at) VALUES ('parked','qualifier','Other','','','different',${JSON.stringify([candidate.id])},'yesterday')`;
      yield* sql`INSERT INTO agent_requests (id,payload_json) VALUES ('waiting','{"threadId":"parked","status":"pending"}')`;
    }
    if (reason === "paused")
      yield* sql`UPDATE autonomous_agents SET payload_json = json_set(payload_json, '$.paused', 1) WHERE id = 'qualifier'`;
    const refs = [members[1]!, candidate].map(({ id, version }) => ({
      id,
      expectedVersion: version,
    }));
    if (reason === "limit") {
      for (let i = 0; i < 19; i++) {
        const task = yield* service.save({ ...seed, id: `extra-${i}`, expectedVersion: 0 });
        refs.push({ id: task.id, expectedVersion: task.version });
      }
    }
    const before = yield* service.list();
    const error = yield* service
      .reserveQualification(
        { tasks: refs },
        reason === "caller" ? ThreadId.make("unknown") : threadId,
      )
      .pipe(Effect.flip);
    expect(error.reason).toBe(
      reason === "project"
        ? "project"
        : reason === "paused" || reason === "caller"
          ? "agent"
          : "conflict",
    );
    expect(yield* service.list()).toEqual(before);
    expect(
      (yield* sql<{
        task_ids_json: string;
      }>`SELECT task_ids_json FROM autonomous_agent_runs WHERE thread_id = ${threadId}`)[0]
        ?.task_ids_json,
    ).toBe("[]");
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("consolidates one request from a mixed DM and preserves every source", () =>
  Effect.gen(function* () {
    const { service, members, seed, threadId, input } = yield* qualificationFixture;
    const principal = yield* service.save(input, threadId);
    expect(principal.status).toBe("todo");
    expect(principal.qualifiedAt).toBeTruthy();
    expect(principal.mergedTaskIds).toHaveLength(14);
    expect((yield* service.messages(seed.id)).map((entry) => entry.text)).toEqual(
      Array.from({ length: 15 }, (_, index) => `A${index}`),
    );
    for (const source of members) {
      const stored = yield* service.read(source.id);
      expect(stored.status).toBe("merged");
      expect(stored.notes).toBe(
        `Fusionnée dans : ${principal.title} — ID : ${principal.id}\n\n${source.notes}`,
      );
      expect(yield* service.messages(source.id)).toHaveLength(1);
    }
    expect(
      (yield* service.list())
        .filter((task) => task.status === "unqualified")
        .map((task) => task.title)
        .sort(),
    ).toEqual(["cotily — B15", "cotily — B16", "cotily — B17", "cotily — B18", "cotily — B19"]);
    expect((yield* service.save(input, threadId).pipe(Effect.flip)).reason).toBe("conflict");
    expect(yield* service.read(seed.id)).toEqual(principal);
    expect(yield* service.ingestSlack(message())).toBe("duplicate");
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect.each(["version", "reserved", "qualified", "associated", "dependency", "caller"] as const)(
  "refuses unsafe group (%s) without partial writes",
  (reason) =>
    Effect.gen(function* () {
      const { service, sql, seed, members, threadId, input } = yield* qualificationFixture;
      const member = members[0]!;
      if (reason === "version")
        yield* service.save({
          ...member,
          notes: "Nouvelle précision",
          expectedVersion: member.version,
        });
      if (reason === "qualified")
        yield* service.save({ ...member, status: "todo", expectedVersion: member.version });
      if (reason === "reserved")
        yield* sql`INSERT INTO autonomous_agent_runs (thread_id,agent_id,title,prompt,started_at,task_id) VALUES ('another-thread','qualifier','Other','','',${member.id})`;
      if (reason === "associated")
        yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.agentThreadId', 'associated') WHERE id = ${member.id}`;
      if (reason === "dependency")
        yield* sql`UPDATE work_tasks SET payload_json = json_set(payload_json, '$.dependsOn', json(${JSON.stringify([member.id])})) WHERE id = ${seed.id}`;
      const before = yield* service.list();
      const result = yield* service
        .save(input, reason === "caller" ? ThreadId.make("unrelated") : threadId)
        .pipe(Effect.flip);
      expect(result.reason).toBe("conflict");
      expect(yield* service.list()).toEqual(before);
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("groups replies only while a task is unqualified and preserves edited notes", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    expect(yield* service.ingestSlack(message())).toBe("created");
    const initial = (yield* service.list())[0]!;
    expect(initial.status).toBe("unqualified");
    const edited = yield* service.save({
      ...initial,
      notes: "Contexte manuel",
      expectedVersion: initial.version,
    });
    expect(
      yield* service.ingestSlack(message({ ts: "1793278001.000001", text: "Une précision" })),
    ).toBe("appended");
    const grouped = (yield* service.list())[0]!;
    expect(grouped.notes).toBe("Contexte manuel");
    expect((yield* service.messages(grouped.id)).map((entry) => entry.text)).toEqual([
      "Une demande client",
      "Une précision",
    ]);
    expect(
      (yield* service.save({ ...edited, expectedVersion: edited.version }).pipe(Effect.flip))
        .reason,
    ).toBe("conflict");
    yield* service.save({ ...grouped, status: "doing", expectedVersion: grouped.version });
    expect(yield* service.ingestSlack(message({ ts: "1793278002.000001" }))).toBe("created");
    expect(yield* service.ingestSlack(message({ ts: "1793278003.000001" }))).toBe("appended");
    const tasks = yield* service.list();
    expect(tasks.map((task) => task.status)).toEqual(["unqualified", "doing"]);
    expect(
      yield* Effect.forEach(tasks, (task) =>
        service.messages(task.id).pipe(Effect.map((messages) => messages.length)),
      ),
    ).toEqual([2, 2]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("deduplicates concurrent ingestion and never recreates deleted or completed tasks", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const results = yield* Effect.all(
      [service.ingestSlack(message()), service.ingestSlack(message())],
      { concurrency: "unbounded" },
    );
    expect(results.toSorted()).toEqual(["created", "duplicate"]);
    const task = (yield* service.list())[0]!;
    const done = yield* service.save({ ...task, status: "done", expectedVersion: task.version });
    expect(yield* service.ingestSlack(message())).toBe("duplicate");
    yield* service.delete({ id: done.id, expectedVersion: done.version });
    expect(yield* service.ingestSlack(message())).toBe("duplicate");
    expect(yield* service.list()).toEqual([]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "keeps workspace and channel identities separate and handles a reply arriving first",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      yield* service.ingestSlack(message({ ts: "1793278001.000001" }));
      expect(yield* service.ingestSlack(message())).toBe("appended");
      yield* service.ingestSlack(message({ channelId: "COTHER" }));
      yield* service.ingestSlack(message({ workspaceId: "TOTHER" }));
      expect(yield* service.list()).toHaveLength(3);
      const grouped = (yield* service.list()).at(-1)!;
      expect((yield* service.messages(grouped.id)).map((entry) => entry.ts)).toEqual([
        "1793278000.000001",
        "1793278001.000001",
      ]);
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "keeps tasks, permits completion and reopening, and rejects stale saves and deletes",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const input = yield* decodeInput({
        id: "test",
        expectedVersion: 0,
        title: "Préparer",
        notes: "Notes",
        status: "todo",
        projectId: null,
        agentThreadId: null,
        dueDate: "2028-02-29",
      });
      const created = yield* service.save(input);
      expect((yield* service.list())[0]).toEqual(created);
      const done = yield* service.save({
        ...input,
        expectedVersion: created.version,
        status: "done",
      });
      expect(done.status).toBe("done");
      expect((yield* service.save(input).pipe(Effect.flip)).reason).toBe("conflict");
      expect(
        (yield* service
          .delete({ id: input.id, expectedVersion: created.version })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const reopened = yield* service.save({ ...input, expectedVersion: done.version });
      expect(reopened.status).toBe("todo");
      yield* service.delete({ id: input.id, expectedVersion: reopened.version });
      expect(yield* service.list()).toEqual([]);
      expect(
        (yield* service.save({ ...input, expectedVersion: reopened.version }).pipe(Effect.flip))
          .reason,
      ).toBe("conflict");
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("retains message deduplication across service restarts", () =>
  Effect.gen(function* () {
    yield* Effect.flatMap(Tasks.WorkTaskService, (service) => service.ingestSlack(message())).pipe(
      Effect.provide(Tasks.layer),
    );
    yield* Effect.gen(function* () {
      const restarted = yield* Tasks.WorkTaskService;
      expect(yield* restarted.ingestSlack(message())).toBe("duplicate");
      expect(yield* restarted.list()).toHaveLength(1);
    }).pipe(Effect.provide(Tasks.layer));
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("does not overwrite an unrelated task when its ID conflicts with an import", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const source = message();
    const manual = yield* service.save({
      id: `slack:${source.workspaceId}:${source.channelId}:${source.ts}`,
      expectedVersion: 0,
      title: "Tâche manuelle",
      notes: "À conserver",
      status: "todo",
      projectId: null,
      agentThreadId: null,
      dueDate: null,
    });
    expect((yield* service.ingestSlack(source).pipe(Effect.flip)).reason).toBe("storage");
    expect(yield* service.list()).toEqual([manual]);
    expect(yield* service.messages(manual.id)).toEqual([]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("refuses unavailable project and agent assignments without creating a task", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const input = yield* decodeInput({
      id: "assignment",
      expectedVersion: 0,
      title: "Relire",
      notes: "",
      status: "todo",
      projectId: "missing",
      agentThreadId: null,
      dueDate: null,
    });
    expect((yield* service.save(input).pipe(Effect.flip)).reason).toBe("project");
    const missingAgent = yield* decodeInput({
      ...input,
      projectId: null,
      agentThreadId: "missing",
    });
    expect((yield* service.save(missingAgent).pipe(Effect.flip)).reason).toBe("agent");
    expect(yield* service.list()).toEqual([]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("persists configurable type prompts and rejects stale configuration writes", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const initial = yield* service.types();
    expect(initial.types.map((t) => t.name)).toEqual(["Feature", "Fix"]);
    yield* service.saveTypes({
      version: initial.version,
      types: [{ id: "custom", name: "Analyse", prompt: "Analyse sans modifier." }],
    });
    expect((yield* service.types()).types).toEqual([
      { id: "custom", name: "Analyse", prompt: "Analyse sans modifier." },
    ]);
    expect((yield* service.saveTypes(initial).pipe(Effect.flip)).reason).toBe("conflict");
    const config = yield* service.types();
    yield* service.saveTypes({ ...config, types: [] });
    expect((yield* service.types()).types).toEqual([]);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "allows many tasks per discussion but refuses taking or releasing another discussion’s task",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-10-30T10:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'Project', '/tmp/project', '[]', ${now}, ${now})`;
      for (const id of ["thread-a", "thread-b"]) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'project', ${id}, 'codex', 'approval-required', 'default', ${now}, ${now}, '{}')`;
      }
      const makeTask = (id: string) =>
        service.save({
          id,
          title: id,
          notes: "",
          status: "todo",
          projectId: null,
          agentThreadId: null,
          dueDate: null,
          expectedVersion: 0,
        });
      const first = yield* makeTask("first");
      const second = yield* makeTask("second");
      const a = ThreadId.make("thread-a"),
        b = ThreadId.make("thread-b");
      const claimedA = yield* service.claim(a, { id: first.id, expectedVersion: first.version });
      expect(
        (yield* service
          .claim(b, { id: first.id, expectedVersion: claimedA.version })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(
        (yield* service
          .claim(b, { id: first.id, expectedVersion: claimedA.version }, true)
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(claimedA.projectId).toBe("project");
      yield* service.claim(a, { id: second.id, expectedVersion: second.version });
      expect((yield* service.list()).filter((t) => t.agentThreadId === a)).toHaveLength(2);
      expect(
        (yield* service.claim(a, { id: first.id, expectedVersion: first.version })).version,
      ).toBe(claimedA.version);
      expect(
        (yield* service
          .claim(a, { id: first.id, expectedVersion: first.version }, true)
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const released = yield* service.claim(
        a,
        { id: first.id, expectedVersion: claimedA.version },
        true,
      );
      expect(released.agentThreadId).toBeNull();
      expect(released.status).toBe("todo");
      const takenByB = yield* service.claim(b, { id: first.id, expectedVersion: released.version });
      expect(takenByB.agentThreadId).toBe(b);
      const unassigned = yield* service.claim(
        b,
        { id: first.id, expectedVersion: takenByB.version },
        true,
      );
      const done = yield* service.save({
        ...unassigned,
        status: "done",
        expectedVersion: unassigned.version,
      });
      expect(
        (yield* service.claim(a, { id: first.id, expectedVersion: done.version }).pipe(Effect.flip))
          .reason,
      ).toBe("conflict");
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "records qualification once and preserves it through edits, completion and reopening",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      yield* service.ingestSlack(message());
      const initial = (yield* service.list())[0]!;
      expect(initial.qualifiedAt).toBeUndefined();
      yield* TestClock.setTime(Date.parse("2026-11-02T14:35:00Z"));
      let task = yield* service.save({
        ...initial,
        status: "todo",
        expectedVersion: initial.version,
      });
      expect(task.qualifiedAt).toBe("2026-11-02T14:35:00.000Z");
      yield* TestClock.adjust("1 hour");
      for (const status of ["todo", "doing", "done", "todo", "unqualified", "todo"] as const) {
        task = yield* service.save({ ...task, status, expectedVersion: task.version });
        expect(task.qualifiedAt).toBe("2026-11-02T14:35:00.000Z");
        expect((yield* service.read(task.id)).qualifiedAt).toBe(task.qualifiedAt);
      }
      const created = yield* service.save({
        ...initial,
        id: "manual-todo",
        status: "todo",
        expectedVersion: 0,
      });
      expect(created.qualifiedAt).toBe(created.createdAt);
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("does not invent a qualification date for legacy tasks when edited or reopened", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* service.ingestSlack(message());
    const initial = (yield* service.list())[0]!;
    const legacy = { ...initial, status: "todo" as const };
    yield* sql`UPDATE work_tasks SET payload_json = ${JSON.stringify(legacy)} WHERE id = ${legacy.id}`;
    let task = yield* service.read(legacy.id);
    for (const status of ["todo", "done", "todo"] as const) {
      task = yield* service.save({ ...task, status, expectedVersion: task.version });
      expect(task.qualifiedAt).toBeNull();
    }
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "keeps merged tasks and their sources readable, prevents execution, and allows reopening",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const agents = yield* Agents.WorkTaskAgentService;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-11-02T10:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'Project', '/tmp/project', '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread', 'project', 'Thread', 'codex', 'approval-required', 'default', ${now}, ${now}, '{}')`;
      const source = message();
      yield* service.ingestSlack(source);
      let initial = (yield* service.list())[0]!;
      for (const status of ["unqualified", "todo"] as const) {
        initial = yield* service.save(
          yield* decodeInput({
            ...initial,
            status,
            projectId: "project",
            expectedVersion: initial.version,
          }),
        );
        expect(
          (yield* agents
            .launch({
              id: initial.id,
              expectedVersion: initial.version,
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("preparation");
        expect(yield* service.read(initial.id)).toEqual(initial);
      }
      const merged = yield* service.save(
        yield* decodeInput({
          ...initial,
          projectId: "project",
          status: "merged",
          notes: "Fusionnée dans la tâche principale. Contexte original conservé.",
          expectedVersion: initial.version,
        }),
      );
      expect(yield* service.read(merged.id)).toEqual(merged);
      expect(yield* service.messages(merged.id)).toEqual([source]);
      expect((yield* service.list())[0]?.status).toBe("merged");
      const claim = { id: merged.id, expectedVersion: merged.version };
      expect((yield* service.claim(ThreadId.make("thread"), claim).pipe(Effect.flip)).reason).toBe(
        "conflict",
      );
      expect(
        (yield* agents
          .launch({
            ...claim,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(yield* service.read(merged.id)).toEqual(merged);
      expect(
        (yield* service
          .save({ ...merged, status: "todo", expectedVersion: initial.version })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const reopened = yield* service.save({
        ...merged,
        status: "todo",
        expectedVersion: merged.version,
      });
      expect(reopened.status).toBe("todo");
      expect(reopened.notes).toBe(merged.notes);
      expect(yield* service.messages(reopened.id)).toEqual([source]);
      expect(
        (yield* service.claim(ThreadId.make("thread"), {
          id: reopened.id,
          expectedVersion: reopened.version,
        })).agentThreadId,
      ).toBe("thread");
    }).pipe(
      Effect.provide(
        Agents.layer.pipe(
          Layer.provideMerge(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
          Layer.provide(Layer.mock(Launch.ThreadLaunchService)({})),
        ),
      ),
    ),
);

it.effect(
  "settling the associated agent completes its open tasks and preserves closed and unrelated tasks",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const statuses = [
        "todo",
        "ready",
        "doing",
        "review",
        "done",
        "rejected",
        "merged",
        "unqualified",
      ] as const;
      for (const status of statuses) {
        const task = {
          id: status,
          title: status,
          notes: "Keep notes",
          status,
          projectId: null,
          agentThreadId: "agent",
          dueDate: null,
          version: 1,
          createdAt: "before",
          updatedAt: "before",
        };
        yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES (${status}, 1, ${JSON.stringify(task)})`;
      }
      const other = {
        id: "other",
        title: "Other",
        notes: "",
        status: "doing",
        projectId: null,
        agentThreadId: "other-agent",
        dueDate: null,
        version: 1,
        createdAt: "before",
        updatedAt: "before",
      };
      yield* sql`INSERT INTO work_tasks (id, version, payload_json) VALUES ('other', 1, ${JSON.stringify(other)})`;
      const finished = yield* Deferred.make<void>();
      const thread = idleThreadProjection(liveThreadShell(ThreadId.make("agent"))).thread;
      const event: OrchestrationV2DomainEvent = {
        type: "thread.settled",
        id: EventId.make("settlement"),
        threadId: thread.id,
        occurredAt: thread.updatedAt,
        payload: { ...thread, settledOverride: "settled", settledAt: thread.updatedAt },
      };
      const events = Stream.fromIterable([event, event]).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(finished, undefined)).pipe(Stream.drain)),
      );
      yield* Layer.build(
        SettlementWorker.layer.pipe(
          Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: events })),
        ),
      );
      yield* Deferred.await(finished);
      for (const status of statuses) {
        const task = yield* service.read(status);
        const completed = ["todo", "ready", "doing", "review"].includes(status);
        expect(task.status).toBe(completed ? "done" : status);
        expect(task.version).toBe(completed ? 2 : 1);
        expect(task.notes).toBe("Keep notes");
      }
      expect(yield* service.read("other")).toEqual(other);
      const once = yield* service.list();
      yield* service.completeForSettledThread(ThreadId.make("agent"));
      expect(yield* service.list()).toEqual(once);
    }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("limits a Chef's task execution to its project and respects its pause", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("chef-thread");
    const payload = JSON.stringify({
      kind: "chef",
      trigger: "interval",
      projectId: "chef-project",
      paused: false,
    });
    yield* sql`INSERT INTO autonomous_agents (id, payload_json) VALUES ('chef', ${payload})`;
    yield* sql`INSERT INTO autonomous_agent_runs (thread_id, agent_id, title, prompt, started_at) VALUES (${threadId}, 'chef', 'Chef', '', '')`;
    const task = {
      ...(yield* decodeInput({
        id: "task",
        title: "Prête",
        notes: "",
        status: "ready",
        projectId: "chef-project",
        agentThreadId: null,
        dueDate: null,
        expectedVersion: 0,
      })),
      version: 1,
      createdAt: "now",
      updatedAt: "now",
    };
    yield* service.assertCanStart(task, threadId);
    expect(
      (yield* service.assertCanStart({ ...task, projectId: null }, threadId).pipe(Effect.flip))
        .reason,
    ).toBe("project");
    expect(
      (yield* service
        .assertCanStart({ ...task, projectId: ProjectId.make("other-project") }, threadId)
        .pipe(Effect.flip)).reason,
    ).toBe("project");
    expect(
      (yield* service
        .assertCanStart({ ...task, chantierId: "chantier" }, threadId)
        .pipe(Effect.flip)).reason,
    ).toBe("chantierScope");
    yield* sql`UPDATE autonomous_agents SET payload_json = json_set(payload_json, '$.paused', 1) WHERE id = 'chef'`;
    expect((yield* service.assertCanStart(task, threadId).pipe(Effect.flip)).reason).toBe(
      "project",
    );
    yield* service.assertCanStart(task);
  }).pipe(Effect.provide(Tasks.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
