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
import { ProviderInstanceId, ThreadId, WorkTaskSaveInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "./WorkTaskService.ts";
import * as Agents from "./WorkTaskAgentService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Requests from "../agentRequests/AgentRequestService.ts";
import * as RequestEffects from "../agentRequests/RequestEffects.ts";
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

it.effect("requires an accepted keep request for the qualifier's own task before todo", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const requests = yield* Requests.AgentRequestService;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("qualifier-thread");
    yield* service.ingestSlack(message());
    const task = (yield* service.list())[0]!;
    yield* sql`INSERT INTO autonomous_agents (id, payload_json)
      VALUES ('qualifier', '{"trigger":"unqualified"}')`;
    yield* sql`INSERT INTO autonomous_agent_runs
      (thread_id, agent_id, title, prompt, started_at, task_id)
      VALUES (${threadId}, 'qualifier', 'Qualification', '', '', ${task.id})`;
    const save = () =>
      service.save({ ...task, status: "todo", expectedVersion: task.version }, threadId);
    const denied = Effect.gen(function* () {
      expect((yield* save().pipe(Effect.flip)).reason).toBe("approval");
      expect(yield* service.read(task.id)).toEqual(task);
    });
    yield* denied;
    const proposal = {
      context: "Une demande client",
      question: "Conserver cette tâche",
      details: "Proposition de qualification",
      kind: "approval" as const,
      qualification: { decision: "keep" as const, source: "Slack - #cotily" },
      action: null,
    };
    const other = yield* requests.create(ThreadId.make("other-thread"), {
      ...proposal,
      id: "other",
    });
    yield* requests.respond({
      id: other.id,
      expectedVersion: other.version,
      decision: "accept",
      text: "",
    });
    yield* denied;
    const refusal = yield* requests.create(threadId, {
      ...proposal,
      id: "refusal",
      qualification: { ...proposal.qualification, decision: "reject" },
    });
    yield* requests.respond({
      id: refusal.id,
      expectedVersion: refusal.version,
      decision: "accept",
      text: "",
    });
    yield* denied;
    const question = yield* requests.create(threadId, {
      ...proposal,
      id: "question",
      kind: "text",
    });
    yield* requests.respond({
      id: question.id,
      expectedVersion: question.version,
      decision: "answer",
      text: "Oui",
    });
    yield* denied;
    for (const decision of ["ignore", "reject", "revise", "accept"] as const) {
      const request = yield* requests.create(threadId, { ...proposal, id: decision });
      yield* denied;
      yield* requests.respond({
        id: request.id,
        expectedVersion: request.version,
        decision,
        text: "Décision",
      });
      if (decision !== "accept") yield* denied;
    }
    yield* service.ingestSlack(message({ channelId: "COTHER" }));
    const otherTask = (yield* service.list())[0]!;
    expect(
      (yield* service
        .save({ ...otherTask, status: "todo", expectedVersion: otherTask.version }, threadId)
        .pipe(Effect.flip)).reason,
    ).toBe("approval");
    const qualified = yield* save();
    expect(qualified.status).toBe("todo");
    expect(
      (yield* service
        .save({ ...qualified, status: "ready", expectedVersion: qualified.version }, threadId)
        .pipe(Effect.flip)).reason,
    ).toBe("preparation");
    expect((yield* service.read(task.id)).status).toBe("todo");
    const prepared = yield* service.save(
      { ...qualified, status: "ready", expectedVersion: qualified.version },
      ThreadId.make("coordinator-thread"),
    );
    expect((yield* service.read(task.id)).status).toBe("ready");
    expect(prepared.qualifiedAt).toBe(qualified.qualifiedAt);
    // Manual changes remain available without an autonomous caller.
    expect(
      (yield* service.save({ ...otherTask, status: "todo", expectedVersion: otherTask.version }))
        .status,
    ).toBe("todo");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Tasks.layer, Requests.layer).pipe(
        Layer.provide(
          Layer.succeed(RequestEffects.RequestEffects, {
            execute: () => Effect.succeed(true),
            notify: () => Effect.void,
          }),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
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
