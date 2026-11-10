import {
  InboxSubjectActionInput,
  InboxSubjectActionResult,
  InboxSubjectActionError,
  WorkTaskSaveInput,
  WorkTaskError,
  workTaskSources,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tasks from "../workTasks/WorkTaskService.ts";

export class InboxSubjectActions extends Context.Service<
  InboxSubjectActions,
  {
    readonly apply: (
      input: InboxSubjectActionInput,
    ) => Effect.Effect<
      typeof InboxSubjectActionResult.Type,
      InboxSubjectActionError | WorkTaskError
    >;
  }
>()("t3/inbox/InboxSubjectActions") {}

const decodeInput = Schema.decodeEffect(InboxSubjectActionInput);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(InboxSubjectActionInput));
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(InboxSubjectActionResult));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(InboxSubjectActionResult));
const validateTask = Schema.decodeEffect(WorkTaskSaveInput);
const isActionError = Schema.is(InboxSubjectActionError);
const isTaskError = Schema.is(WorkTaskError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* Tasks.WorkTaskService;
  const crypto = yield* Crypto.Crypto;
  const apply = Effect.fn("InboxSubjectActions.apply")(
    function* (raw: InboxSubjectActionInput) {
      const input = yield* decodeInput(raw).pipe(
        Effect.mapError(() => new InboxSubjectActionError({ reason: "validation" })),
      );
      const encoded = yield* encodeInput(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [receipt] = yield* sql<{
            input_json: string;
            result_json: string;
          }>`SELECT input_json,result_json
        FROM inbox_subject_actions WHERE request_id=${input.requestId}`;
          if (receipt) {
            if (receipt.input_json !== encoded)
              return yield* new InboxSubjectActionError({ reason: "conflict" });
            return yield* decodeResult(receipt.result_json);
          }
          const [subject] = yield* sql<{
            action_version: number;
            ignored: number;
            task_id: string | null;
            title: string;
            closed_at: string | null;
          }>`
        SELECT action_version,ignored,task_id,title,closed_at FROM inbox_subjects WHERE id=${input.subjectId}`;
          if (!subject) return yield* new InboxSubjectActionError({ reason: "missing" });
          if (subject.closed_at !== null)
            return yield* new InboxSubjectActionError({ reason: "closed" });
          if (subject.action_version !== input.expectedVersion)
            return yield* new InboxSubjectActionError({ reason: "conflict" });
          const now = DateTime.formatIso(yield* DateTime.now);
          let taskId = subject.task_id;
          if (input.kind !== "ignore") {
            if (subject.ignored) return yield* new InboxSubjectActionError({ reason: "conflict" });
            if (
              (input.kind === "create" && subject.task_id) ||
              (input.kind === "update" && subject.task_id !== input.taskId)
            )
              return yield* new InboxSubjectActionError({ reason: "linked" });
            const previous = input.kind === "update" ? yield* tasks.read(input.taskId) : null;
            if (previous?.status === "done")
              return yield* new InboxSubjectActionError({ reason: "closed" });
            if (
              input.kind === "update" &&
              previous &&
              (previous.version !== input.taskVersion || previous.projectId !== input.projectId)
            )
              return yield* new InboxSubjectActionError({
                reason: previous.projectId !== input.projectId ? "project" : "conflict",
              });
            taskId = previous?.id ?? `inbox-subject:${yield* crypto.randomUUIDv4}`;
            const entries = yield* sql<{
              url: string;
              kind: "gmail" | "slack";
            }>`SELECT DISTINCT json_extract(m.payload_json,'$.url') AS url,json_extract(m.payload_json,'$.source.kind') AS kind FROM inbox_subject_entries e
          JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=${input.subjectId}
          AND NOT EXISTS (SELECT 1 FROM inbox_subject_task_sources s WHERE s.subject_id=e.subject_id AND s.entry_id=e.entry_id AND s.task_id=${taskId})
          ORDER BY m.sequence LIMIT 51`;
            const sources = [...(previous ? workTaskSources(previous) : [])];
            for (const entry of entries) {
              const kind = entry.kind === "gmail" ? "email" : "slack";
              if (!sources.some((source) => source.url === entry.url))
                sources.push({
                  kind,
                  label: kind === "email" ? "Email · Inbox" : "Slack · Inbox",
                  url: entry.url,
                });
            }
            const notes = previous
              ? [
                  previous.notes,
                  input.description.trim()
                    ? `Sujet Inbox : ${subject.title}\n${input.description}`
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n")
              : input.description;
            if (
              notes.length > 20_000 ||
              sources.length > 50 ||
              ((previous?.inboxSubjectIds?.length ?? 0) >= 200 &&
                !previous?.inboxSubjectIds?.includes(input.subjectId))
            )
              return yield* new InboxSubjectActionError({ reason: "limit" });
            // Only the reviewed text and provenance change. In particular, never resubmit stored attachments as pending uploads.
            const { attachments: _attachments, ...retained } = previous ?? {};
            const draft = yield* validateTask({
              ...retained,
              id: taskId,
              expectedVersion: previous?.version ?? 0,
              title: input.title,
              notes,
              sources,
              status: previous?.status ?? "ready",
              projectId: input.projectId,
              agentThreadId: previous?.agentThreadId ?? null,
              dueDate: previous?.dueDate ?? null,
              automationMode: "manual",
              inboxSubjectIds: [
                ...new Set([...(previous?.inboxSubjectIds ?? []), input.subjectId]),
              ],
            });
            yield* tasks.save(draft);
            yield* sql`INSERT INTO inbox_subject_task_sources(subject_id,entry_id,task_id,linked_at)
          SELECT subject_id,entry_id,${taskId},${now} FROM inbox_subject_entries WHERE subject_id=${input.subjectId}
          ON CONFLICT(subject_id,entry_id,task_id) DO NOTHING`;
          }
          const result = {
            subjectId: input.subjectId,
            actionVersion: subject.action_version + 1,
            ignored: input.kind === "ignore" ? input.ignored : Boolean(subject.ignored),
            taskId,
            processed: input.kind !== "ignore" || input.ignored,
            closedAt: null,
          };
          const restore = input.kind === "ignore" && !input.ignored;
          yield* sql`UPDATE inbox_subjects SET action_version=${result.actionVersion},ignored=${Number(result.ignored)},task_id=${taskId},
            handled_sequence=${restore ? sql`0` : sql`COALESCE((SELECT MAX(m.sequence) FROM inbox_subject_entries e JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=${input.subjectId}),0)`}
        WHERE id=${input.subjectId}`;
          yield* sql`INSERT INTO inbox_subject_actions(request_id,subject_id,input_json,result_json,created_at)
        VALUES(${input.requestId},${input.subjectId},${encoded},${yield* encodeResult(result)},${now})`;
          return result;
        }),
      );
    },
    Effect.mapError((cause) =>
      isActionError(cause) || isTaskError(cause)
        ? cause
        : new InboxSubjectActionError({ reason: "storage" }),
    ),
  );
  return InboxSubjectActions.of({ apply });
});
export const layer = Layer.effect(InboxSubjectActions, make);
