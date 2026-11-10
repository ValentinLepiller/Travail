import {
  InboxMessage,
  InboxSubject,
  InboxListInput,
  InboxSubjectEntriesInput,
  InboxSubjectsPage,
  InboxPage,
  InboxGroupingStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";
import * as Model from "./InboxSubjectModel.ts";
import { SubjectDecision, subjectPrompt } from "./subjectPrompt.ts";
import * as SubjectContext from "./subjectContext.ts";

export class InboxSubjectError extends Schema.TaggedError<InboxSubjectError>()(
  "InboxSubjectError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Impossible d’accéder aux sujets de l’inbox.";
  }
}
export class InboxSubjectService extends Context.Service<
  InboxSubjectService,
  {
    readonly status: () => Effect.Effect<typeof InboxGroupingStatus.Type, InboxSubjectError>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<typeof InboxGroupingStatus.Type, InboxSubjectError>;
    readonly list: (
      input: typeof InboxListInput.Type,
    ) => Effect.Effect<typeof InboxSubjectsPage.Type, InboxSubjectError>;
    readonly entries: (
      input: typeof InboxSubjectEntriesInput.Type,
    ) => Effect.Effect<typeof InboxPage.Type, InboxSubjectError>;
    readonly processNext: () => Effect.Effect<void, InboxSubjectError>;
    readonly processContextNext: () => Effect.Effect<void, InboxSubjectError>;
  }
>()("t3/inbox/InboxSubjectService") {}
const decodeList = Schema.decodeEffect(InboxListInput);
const decodeEntriesInput = Schema.decodeEffect(InboxSubjectEntriesInput);
const isModelError = Schema.is(Model.SubjectModelError);
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(InboxMessage));
const decodeDecision = Schema.decodeEffect(Schema.fromJsonString(SubjectDecision));
const encodeDecision = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...SubjectDecision.fields,
      created: Schema.Boolean,
      model: Schema.String,
      instanceId: Schema.String,
      candidatesExamined: Schema.Int,
    }),
  ),
);
type Worker = {
  enabled: number;
  entry_id: string | null;
  token: string | null;
  next_at: string;
  attempts: number;
  error: string | null;
};
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const model = yield* Model.InboxSubjectModel;
  const lock = yield* Semaphore.make(1);
  const head = sql<{
    id: string;
    sequence: number;
    payload_json: string;
  }>`SELECT m.id,m.sequence,m.payload_json FROM message_inbox m
    LEFT JOIN inbox_subject_entries e ON e.entry_id=m.id WHERE e.entry_id IS NULL
    AND json_extract(m.payload_json,'$.qualification.category') IS NOT 'no_action'
    ORDER BY m.sequence LIMIT 1`;
  const worker = sql<Worker>`SELECT * FROM inbox_subject_worker WHERE id=1`;
  const pendingContext = sql` s.closed_at IS NULL AND s.ignored=0 AND
    s.context_sequence < COALESCE((SELECT MAX(m.sequence) FROM inbox_subject_entries e
      JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=s.id),0)`;
  const status = Effect.fn("InboxSubjectService.status")(
    function* () {
      const [w] = yield* worker;
      const [counts] = yield* sql<{
        processed: number;
        created: number;
        excluded: number;
        remaining: number;
        waiting: number;
      }>`SELECT
      COUNT(e.entry_id) AS processed,
      COALESCE(SUM(CASE WHEN json_extract(e.decision_json,'$.created')=1 THEN 1 ELSE 0 END),0) AS created,
      SUM(CASE WHEN json_extract(m.payload_json,'$.qualification.category')='no_action' THEN 1 ELSE 0 END) AS excluded,
      SUM(CASE WHEN e.entry_id IS NULL AND json_extract(m.payload_json,'$.qualification.category') IS NOT 'no_action'
        AND json_extract(m.payload_json,'$.qualification.status')='qualified' THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN json_extract(m.payload_json,'$.qualification.status') IS NOT 'qualified' THEN 1 ELSE 0 END) AS waiting
      FROM message_inbox m LEFT JOIN inbox_subject_entries e ON e.entry_id=m.id`;
      const [subjects] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM inbox_subjects`;
      const [first] = yield* head;
      const entry = first ? yield* decodeEntry(first.payload_json) : null;
      const current = w!.entry_id === first?.id;
      const [contexts] = yield* sql<{ pending: number; errors: number }>`SELECT COUNT(*) AS pending,
        COALESCE(SUM(s.context_error IS NOT NULL),0) AS errors FROM inbox_subjects s WHERE ${pendingContext}`;
      const created = counts!.created;
      return {
        contextsPending: contexts!.pending,
        contextErrors: contexts!.errors,
        enabled: Boolean(w!.enabled),
        ...Model.subjectModelSelection,
        subjects: subjects!.count,
        processed: counts!.processed,
        created,
        reused: counts!.processed - created,
        excluded: counts!.excluded ?? 0,
        remaining: counts!.remaining ?? 0,
        waitingJev: counts!.waiting ?? 0,
        errors: current && w!.error ? 1 : 0,
        head:
          first && entry
            ? {
                id: first.id,
                sequence: first.sequence,
                state: !entry.qualification
                  ? ("waiting_jev" as const)
                  : current && w!.error
                    ? ("error" as const)
                    : current && w!.token
                      ? ("processing" as const)
                      : ("pending" as const),
                attempts: current ? w!.attempts : 0,
                nextAttemptAt: current ? w!.next_at : "",
                error: current ? w!.error : null,
              }
            : null,
      };
    },
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  const setEnabled = Effect.fn("InboxSubjectService.setEnabled")(
    function* (enabled: boolean) {
      yield* sql`UPDATE inbox_subject_worker SET enabled=${Number(enabled)} WHERE id=1 AND enabled<>${Number(enabled)}`;
      if (enabled)
        yield* sql`UPDATE inbox_subjects SET context_next_at='',context_error=NULL,context_attempts=0
          WHERE context_error IS NOT NULL`;
      return yield* status();
    },
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  const querySubjects = Effect.fn("InboxSubjectService.list")(
    function* (input: typeof InboxListInput.Type, openOnly = false) {
      const { after, order = "asc", limit = 20, processed } = yield* decodeList(input);
      const cursor =
        after === undefined
          ? sql`1=1`
          : order === "desc"
            ? sql`s.sequence < ${after}`
            : sql`s.sequence > ${after}`;
      const handled = sql`(s.closed_at IS NOT NULL OR (
        (s.ignored=1 OR s.task_id IS NOT NULL) AND NOT EXISTS (
          SELECT 1 FROM inbox_subject_entries pending JOIN message_inbox m ON m.id=pending.entry_id
          WHERE pending.subject_id=s.id AND m.sequence>s.handled_sequence
        )
      ))`;
      const filter = processed === undefined ? sql`1=1` : sql`${handled} = ${Number(processed)}`;
      const rows = yield* sql<
        InboxSubject & { contextJson: string | null }
      >`SELECT s.sequence,s.id,s.title,s.summary,s.created_at AS createdAt,COUNT(e.entry_id) AS entries,
      s.action_version AS actionVersion,s.ignored,s.task_id AS taskId,s.closed_at AS closedAt,${handled} AS processed,
      s.task_link_kind AS taskLinkKind,s.context_json AS contextJson,s.context_reason AS contextReason,
      s.context_updated_at AS contextUpdatedAt,s.context_error AS contextError,s.context_uncertain AS contextUncertain,
      CASE json_extract(s.context_json,'$.kind')
        WHEN 'project' THEN (SELECT title FROM projection_projects WHERE project_id=json_extract(s.context_json,'$.id') AND deleted_at IS NULL)
        WHEN 'chantier' THEN (SELECT json_extract(payload_json,'$.title') FROM work_chantiers WHERE id=json_extract(s.context_json,'$.id'))
        WHEN 'task' THEN (SELECT json_extract(payload_json,'$.title') FROM work_tasks WHERE id=json_extract(s.context_json,'$.id'))
      END AS contextLabel
      FROM inbox_subjects s LEFT JOIN inbox_subject_entries e ON e.subject_id=s.id
      WHERE ${cursor} AND ${filter} AND ${openOnly ? sql`s.closed_at IS NULL` : sql`1=1`}
      GROUP BY s.id ORDER BY s.sequence ${order === "desc" ? sql`DESC` : sql`ASC`} LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      return {
        subjects: yield* Effect.forEach(page, ({ contextJson, ...subject }) =>
          Effect.gen(function* () {
            return {
              ...subject,
              context: contextJson ? yield* SubjectContext.decodeSubjectContext(contextJson) : null,
              contextUncertain: Boolean(subject.contextUncertain),
              ignored: Boolean(subject.ignored),
              processed: Boolean(subject.processed),
            };
          }),
        ),
        nextCursor: rows.length > limit ? page[page.length - 1]!.sequence : null,
      };
    },
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  const list = (input: typeof InboxListInput.Type) => querySubjects(input);
  const entries = Effect.fn("InboxSubjectService.entries")(
    function* (input: typeof InboxSubjectEntriesInput.Type) {
      const { subjectId, after, order = "asc", limit = 5 } = yield* decodeEntriesInput(input);
      const cursor =
        after === undefined
          ? sql`1=1`
          : order === "desc"
            ? sql`m.sequence < ${after}`
            : sql`m.sequence > ${after}`;
      const rows = yield* sql<{
        sequence: number;
        payload_json: string;
      }>`SELECT m.sequence,m.payload_json FROM inbox_subject_entries e
      JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=${subjectId} AND ${cursor} ORDER BY m.sequence ${order === "desc" ? sql`DESC` : sql`ASC`} LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      return {
        messages: yield* Effect.forEach(page, (r) => decodeEntry(r.payload_json)),
        nextCursor: rows.length > limit ? page[page.length - 1]!.sequence : null,
      };
    },
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  const processNext = Effect.fn("InboxSubjectService.processNext")(
    function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [w] = yield* worker;
          if (!w!.enabled || w!.next_at > now) return null;
          const [row] = yield* head;
          if (!row) return null;
          const entry = yield* decodeEntry(row.payload_json);
          if (!entry.qualification) return null;
          const token = yield* crypto.randomUUIDv4;
          const attempts = w!.entry_id === entry.id ? w!.attempts + 1 : 1;
          const lease = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(now), { seconds: 300 }),
          );
          const updated =
            yield* sql`UPDATE inbox_subject_worker SET entry_id=${entry.id},token=${token},attempts=${attempts},next_at=${lease},error=NULL
        WHERE id=1 AND enabled=1 AND next_at<=${now} RETURNING id`;
          return updated.length ? { entry, token, attempts } : null;
        }),
      );
      if (!claimed) return;
      const { entry, token, attempts } = claimed;
      const result = yield* Effect.gen(function* () {
        const [count] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM inbox_subjects WHERE closed_at IS NULL`;
        const total = count!.count;
        let after = 0,
          examined = 0;
        while (true) {
          const page = yield* querySubjects({ after, limit: 20 }, true);
          // Human action metadata must not change Luna's existing candidate input.
          const candidates = page.subjects.map(
            ({
              actionVersion: _version,
              ignored: _ignored,
              taskId: _task,
              processed: _processed,
              closedAt: _closed,
              context: _context,
              contextLabel: _contextLabel,
              contextReason: _contextReason,
              contextUpdatedAt: _contextAt,
              contextError: _contextError,
              contextUncertain: _uncertain,
              taskLinkKind: _linkKind,
              ...candidate
            }) => candidate,
          );
          const prompt = subjectPrompt(entry, candidates, { examinedBefore: examined, total });
          if (new TextEncoder().encode(prompt).length > 60_000)
            return yield* new Model.SubjectModelError({ reason: "limit" });
          const text = yield* model.generate(prompt);
          if (text.length > 5000) return yield* new Model.SubjectModelError({ reason: "format" });
          const decision = yield* decodeDecision(text).pipe(
            Effect.mapError(() => new Model.SubjectModelError({ reason: "format" })),
          );
          examined += page.subjects.length;
          if (
            decision.subjectId !== null &&
            !page.subjects.some((s) => s.id === decision.subjectId)
          )
            return yield* new Model.SubjectModelError({ reason: "format" });
          if (decision.subjectId !== null || page.nextCursor === null)
            return { decision, examined };
          // Bound both the search and the lease. Never create after an incomplete search.
          if (examined >= 100) return yield* new Model.SubjectModelError({ reason: "limit" });
          after = page.nextCursor;
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "240 seconds",
          orElse: () => Effect.fail(new Model.SubjectModelError({ reason: "model" })),
        }),
        Effect.result,
      );
      const finished = DateTime.formatIso(yield* DateTime.now);
      if (result._tag === "Failure") {
        const reason = isModelError(result.failure) ? result.failure.reason : "storage";
        const delay =
          reason === "limit" || reason === "configuration"
            ? 1800
            : Math.min(1800, 30 * 2 ** Math.min(attempts - 1, 6));
        const retry = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(finished), { seconds: delay }),
        );
        yield* sql`UPDATE inbox_subject_worker SET token=NULL,error=${reason},next_at=${retry} WHERE id=1 AND token=${token}`;
        return;
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [w] = yield* worker;
          if (w!.token !== token || w!.next_at <= finished) return;
          const [existing] =
            yield* sql`SELECT entry_id FROM inbox_subject_entries WHERE entry_id=${entry.id}`;
          if (existing) return;
          const { decision, examined } = result.success;
          const created = decision.subjectId === null;
          const subjectId = decision.subjectId ?? (yield* crypto.randomUUIDv4);
          if (!created) {
            const [target] = yield* sql<{
              closed_at: string | null;
            }>`SELECT closed_at FROM inbox_subjects WHERE id=${subjectId}`;
            if (!target || target.closed_at !== null) {
              // The task may finish while Luna is answering. Retry with the current open candidates.
              yield* sql`UPDATE inbox_subject_worker SET token=NULL,entry_id=NULL,next_at='',attempts=0,error=NULL WHERE id=1 AND token=${token}`;
              return;
            }
          }
          const encoded = yield* encodeDecision({
            ...decision,
            subjectId,
            created,
            ...Model.subjectModelSelection,
            candidatesExamined: examined,
          });
          if (created)
            yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at) VALUES(${subjectId},${decision.title},${decision.summary},${finished})`;
          yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES(${entry.id},${subjectId},${finished},${encoded})`;
          if (!created)
            yield* sql`UPDATE inbox_subjects SET ignored=0,action_version=action_version+1 WHERE id=${subjectId}`;
          yield* sql`UPDATE inbox_subject_worker SET token=NULL,entry_id=NULL,next_at='',attempts=0,error=NULL WHERE id=1 AND token=${token}`;
        }),
      );
    },
    lock.withPermits(1),
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  const processContextNext = Effect.fn("InboxSubjectService.processContextNext")(
    function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [w] = yield* worker;
          if (!w!.enabled || w!.next_at > now) return null;
          const [subject] = yield* sql<{
            id: string;
            title: string;
            summary: string;
            task_id: string | null;
            context_next_at: string;
            context_attempts: number;
            sequence: number;
          }>`
          SELECT s.id,s.title,s.summary,s.task_id,s.context_next_at,s.context_attempts,
          (SELECT MAX(m.sequence) FROM inbox_subject_entries e JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=s.id) AS sequence
          FROM inbox_subjects s WHERE ${pendingContext} ORDER BY s.sequence LIMIT 1`;
          if (!subject || subject.context_next_at > now) return null;
          const token = yield* crypto.randomUUIDv4;
          const lease = DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(now), { seconds: 300 }),
          );
          const rows =
            yield* sql`UPDATE inbox_subject_worker SET entry_id=${"context:" + subject.id},token=${token},next_at=${lease},error=NULL
          WHERE id=1 AND enabled=1 AND next_at<=${now} RETURNING id`;
          if (!rows.length) return null;
          yield* sql`UPDATE inbox_subjects SET context_attempts=context_attempts+1 WHERE id=${subject.id}`;
          return { subject, token };
        }),
      );
      if (!claimed) return;
      const { subject, token } = claimed;
      const result = yield* Effect.gen(function* () {
        if (subject.task_id)
          return {
            context: yield* SubjectContext.linkedTaskContext(subject.task_id),
            reason: "Contexte conservé depuis la tâche liée.",
            uncertain: false,
            catalog: null,
          };
        const catalog = yield* SubjectContext.contextCatalog;
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT m.payload_json FROM inbox_subject_entries e
          JOIN message_inbox m ON m.id=e.entry_id WHERE e.subject_id=${subject.id} AND m.sequence<=${subject.sequence} ORDER BY m.sequence DESC LIMIT 5`;
        const messages = (yield* Effect.forEach(rows, (r) => decodeEntry(r.payload_json)))
          .toReversed()
          .map((m) => ({ source: m.source.kind, text: m.source.message.text.slice(0, 1600) }));
        const prompt = SubjectContext.contextPrompt(
          { id: subject.id, title: subject.title, summary: subject.summary },
          messages,
          catalog,
        );
        if (new TextEncoder().encode(prompt).length > 60000)
          return yield* new Model.SubjectModelError({ reason: "limit" });
        const text = yield* model.generate(prompt);
        if (text.length > 5000) return yield* new Model.SubjectModelError({ reason: "format" });
        const decision = yield* SubjectContext.decodeContextDecision(text).pipe(
          Effect.mapError(() => new Model.SubjectModelError({ reason: "format" })),
        );
        return {
          ...decision,
          context: yield* SubjectContext.resolveContext(decision, catalog),
          catalog,
        };
      }).pipe(
        Effect.timeoutOrElse({
          duration: "240 seconds",
          orElse: () => Effect.fail(new Model.SubjectModelError({ reason: "model" })),
        }),
        Effect.result,
      );
      const finished = DateTime.formatIso(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [w] = yield* worker;
          if (w!.token !== token || w!.next_at <= finished) return;
          const [current] = yield* sql<{
            closed_at: string | null;
            task_id: string | null;
            ignored: number;
            context_sequence: number;
          }>`SELECT closed_at,task_id,ignored,context_sequence FROM inbox_subjects WHERE id=${subject.id}`;
          if (
            current &&
            current.closed_at === null &&
            !current.ignored &&
            current.task_id === subject.task_id &&
            current.context_sequence < subject.sequence
          ) {
            const stale =
              result._tag === "Success" &&
              result.success.catalog &&
              !(yield* SubjectContext.contextStillValid(
                result.success.context,
                result.success.catalog,
              ));
            if (result._tag === "Failure" || stale) {
              const reason = stale
                ? "stale"
                : result._tag === "Failure" && isModelError(result.failure)
                  ? result.failure.reason
                  : "storage";
              const seconds =
                reason === "limit"
                  ? 1800
                  : Math.min(1800, 30 * 2 ** Math.min(subject.context_attempts, 6));
              const retry = DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(finished), { seconds }),
              );
              yield* sql`UPDATE inbox_subjects SET context_error=${reason},context_next_at=${retry} WHERE id=${subject.id}`;
            } else if (result._tag === "Success") {
              const value = result.success;
              yield* sql`UPDATE inbox_subjects SET context_json=${yield* SubjectContext.encodeSubjectContext(value.context)},
              context_reason=${value.reason},context_uncertain=${Number(value.uncertain)},context_model=${value.catalog ? Model.subjectModelSelection.model : "linked_task"},
              context_sequence=${subject.sequence},context_updated_at=${finished},context_error=NULL,context_next_at='',context_attempts=0,
              action_version=action_version+1 WHERE id=${subject.id}`;
            }
          }
          yield* sql`UPDATE inbox_subject_worker SET token=NULL,entry_id=NULL,next_at='',attempts=0,error=NULL WHERE id=1 AND token=${token}`;
        }),
      );
    },
    lock.withPermits(1),
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError((cause) => new InboxSubjectError({ cause })),
  );
  return InboxSubjectService.of({
    status,
    setEnabled,
    list,
    entries,
    processNext,
    processContextNext,
  });
});
export const layer = Layer.effect(InboxSubjectService, make);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* InboxSubjectService;
    yield* RuntimeAdmission.admit(
      Effect.gen(function* () {
        yield* service.processNext();
        yield* service.processContextNext();
      }),
    ).pipe(
      Effect.catch(() => Effect.logWarning("Inbox subject storage unavailable; queue retained.")),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
  }),
);
