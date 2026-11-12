import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChatAttachmentId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import {
  createPendingAttachmentId,
  resolveAttachmentPath,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import { seedLegacySlackTask, taskImageTestLayer } from "./WorkTaskService.testkit.ts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import { EventId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as SettlementWorker from "./WorkTaskSettlementWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  "keeps tasks, permits completion and reopening, and rejects stale saves and deletes",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const input = yield* decodeInput({
        id: "test",
        expectedVersion: 0,
        title: "Préparer",
        notes: "Notes",
        status: "ready",
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
      expect(reopened.status).toBe("ready");
      yield* service.delete({ id: input.id, expectedVersion: reopened.version });
      expect(yield* service.list()).toEqual([]);
      expect(
        (yield* service.save({ ...input, expectedVersion: reopened.version }).pipe(Effect.flip))
          .reason,
      ).toBe("conflict");
    }).pipe(
      Effect.provide(
        Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);

it.effect("refuses unavailable project and agent assignments without creating a task", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const input = yield* decodeInput({
      id: "assignment",
      expectedVersion: 0,
      title: "Relire",
      notes: "",
      status: "ready",
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
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
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
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
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
          status: "ready",
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
      expect(released.status).toBe("ready");
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
    }).pipe(
      Effect.provide(
        Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);

it.effect("does not invent a qualification date for legacy tasks when edited or reopened", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacySlackTask(message());
    const initial = (yield* service.list())[0]!;
    const legacy = { ...initial, status: "ready" as const };
    yield* sql`UPDATE work_tasks SET payload_json = ${JSON.stringify(legacy)} WHERE id = ${legacy.id}`;
    let task = yield* service.read(legacy.id);
    for (const status of ["ready", "done", "ready"] as const) {
      task = yield* service.save({ ...task, status, expectedVersion: task.version });
      expect(task.qualifiedAt).toBeNull();
    }
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
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
      yield* seedLegacySlackTask(source);
      let initial = (yield* service.list())[0]!;
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
          .save({ ...merged, status: "ready", expectedVersion: initial.version })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const reopened = yield* service.save({
        ...merged,
        status: "ready",
        expectedVersion: merged.version,
      });
      expect(reopened.status).toBe("ready");
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
          Layer.provideMerge(
            Tasks.layer.pipe(
              Layer.provide(taskImageTestLayer),
              Layer.provideMerge(Sqlite.layerMemory),
            ),
          ),
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
        expect(task.status).toBe(completed ? "done" : status === "unqualified" ? "ready" : status);
        expect(task.version).toBe(completed ? 2 : 1);
        expect(task.notes).toBe("Keep notes");
      }
      expect(yield* service.read("other")).toEqual(other);
      const once = yield* service.list();
      yield* service.completeForSettledThread(ThreadId.make("agent"));
      expect(yield* service.list()).toEqual(once);
    }).pipe(
      Effect.provide(
        Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
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
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);

it.effect(
  "keeps a human task and its pasted image after pending uploads expire without starting an agent",
  () =>
    Effect.gen(function* () {
      const service = yield* Tasks.WorkTaskService;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectId = ProjectId.make("human-project");
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Test','/tmp/human','[]','','')`;
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const image = {
        type: "image" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId()),
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(path.join(config.attachmentsDir, `${image.id}.png`), bytes);
      const created = yield* service.save({
        id: "human-task",
        expectedVersion: 0,
        title: "Un titre humain",
        notes: "Description\navec image",
        attachments: [image],
        projectId,
        status: "ready",
        agentThreadId: null,
        dueDate: null,
      });
      expect(created).toMatchObject({
        title: "Un titre humain",
        notes: "Description\navec image",
        projectId,
        status: "ready",
        agentThreadId: null,
      });
      const storedImage = created.attachments![0]!;
      expect(storedImage).toMatchObject({
        ...image,
        id: expect.stringMatching(/^work-task-human-task-/),
      });
      yield* Effect.sync(() =>
        sweepStalePendingAttachments({
          attachmentsDir: config.attachmentsDir,
          nowMs: Number.MAX_SAFE_INTEGER,
        }),
      );
      expect(
        yield* fs.readFile(
          resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: storedImage,
          })!,
        ),
      ).toEqual(Buffer.from(bytes));
      expect(yield* service.read(created.id)).toEqual(created);
      const { attachments: _images, ...legacyEdit } = created;
      const updated = yield* service.save({
        ...legacyEdit,
        notes: "Description mise à jour",
        expectedVersion: created.version,
      });
      expect(updated.attachments).toEqual(created.attachments);
      expect(yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).toEqual([]);
      expect(yield* sql`SELECT thread_id FROM autonomous_agent_runs`).toEqual([]);
      const removed = yield* service.save({
        ...updated,
        attachments: [],
        expectedVersion: updated.version,
      });
      expect(removed.attachments).toEqual([]);
    }).pipe(
      Effect.provide(
        Tasks.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(taskImageTestLayer),
        ),
      ),
    ),
);

it.effect("refuses to save a task with a missing pasted image", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService;
    const error = yield* service
      .save({
        id: "missing-image",
        expectedVersion: 0,
        title: "Image manquante",
        notes: "À conserver",
        projectId: null,
        status: "ready",
        agentThreadId: null,
        dueDate: null,
        attachments: [
          {
            type: "image",
            id: ChatAttachmentId.make(createPendingAttachmentId()),
            name: "missing.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("storage");
    expect(yield* service.list()).toEqual([]);
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);

it.effect(
  "refuses retired task writes and old collection/qualification paths without side effects",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.WorkTaskService;
      const input: typeof WorkTaskSaveInput.Type = {
        id: "new",
        expectedVersion: 0,
        title: "Action",
        notes: "",
        status: "ready",
        projectId: null,
        agentThreadId: null,
        dueDate: null,
      };
      for (const status of ["todo", "unqualified"]) {
        expect(
          (yield* tasks
            .save({ ...input, status } as typeof WorkTaskSaveInput.Type)
            .pipe(Effect.flip)).reason,
        ).toBe("status");
      }
      expect((yield* tasks.ingestSlack(message()).pipe(Effect.flip)).reason).toBe("status");
      expect(
        (yield* tasks.reserveQualification({ tasks: [] }, ThreadId.make("old")).pipe(Effect.flip))
          .reason,
      ).toBe("status");
      expect(
        (yield* tasks.save({ ...input, qualificationGroup: [] }).pipe(Effect.flip)).reason,
      ).toBe("status");
      expect(yield* tasks.list()).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT task_id FROM work_task_slack_messages`).toEqual([]);
      const created = yield* tasks.save(input);
      expect(created.status).toBe("ready");
      expect(created.qualifiedAt).toBeNull();
    }).pipe(
      Effect.provide(
        Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);

it.effect("a passive Chef dossier cannot become a task execution discussion", () =>
  Effect.gen(function* () {
    const service = yield* Tasks.WorkTaskService,
      sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
    VALUES('chef-dossier:alpha','project','Dossier du Chef','codex','approval-required','default','','','{}')`;
    const error = yield* service
      .save({
        id: "task",
        expectedVersion: 0,
        title: "Corriger",
        notes: "",
        status: "ready",
        projectId: null,
        agentThreadId: ThreadId.make("chef-dossier:alpha"),
        dueDate: null,
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("agent");
    expect(yield* service.list()).toEqual([]);
  }).pipe(
    Effect.provide(
      Tasks.layer.pipe(Layer.provide(taskImageTestLayer), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);
