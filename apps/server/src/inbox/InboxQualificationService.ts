import * as Crypto from "effect/Crypto";
import {
  InboxMessage,
  InboxQualification,
  InboxQualificationStatus,
  InboxQualificationAttempt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Jev from "./JevClient.ts";
import * as RuntimeAdmission from "../maintenance/RuntimeAdmission.ts";

export class InboxQualificationError extends Schema.TaggedError<InboxQualificationError>()(
  "InboxQualificationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Impossible d’accéder à la file de qualification.";
  }
}
export class InboxQualificationService extends Context.Service<
  InboxQualificationService,
  {
    readonly status: () => Effect.Effect<
      typeof InboxQualificationStatus.Type,
      InboxQualificationError
    >;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<typeof InboxQualificationStatus.Type, InboxQualificationError>;
    readonly processNext: () => Effect.Effect<void, InboxQualificationError>;
  }
>()("t3/inbox/InboxQualificationService") {}

const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(InboxMessage));
const encodeAttempt = Schema.encodeEffect(Schema.fromJsonString(InboxQualificationAttempt));
const encodeQualification = Schema.encodeEffect(Schema.fromJsonString(InboxQualification));
const Response = Schema.Struct({
  model: Schema.NonEmptyString,
  answers: Schema.Struct({
    qualification: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: InboxQualification.fields.category,
      probabilities: InboxQualification.fields.probabilities,
      confidence: InboxQualification.fields.confidence,
    }),
  }),
  usage: InboxQualification.fields.usage,
});
const decodeResponse = Schema.decodeUnknownEffect(Response);
const Control = Schema.fromJsonString(Schema.Struct({ enabled: Schema.Boolean }));
const encodeControl = Schema.encodeEffect(Control);
const decodeControl = Schema.decodeEffect(Control);
const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const jev = yield* Jev.JevClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const controlPath = path.join(config.stateDir, "inbox-qualification.json");
  const control = yield* fs.readFileString(controlPath).pipe(
    Effect.flatMap(decodeControl),
    Effect.catch(() => Effect.succeed({ enabled: false })),
  );
  let enabled = control.enabled;
  const head = sql<{
    id: string;
    sequence: number;
    payload_json: string;
  }>`SELECT id,sequence,payload_json FROM message_inbox
    WHERE json_extract(payload_json,'$.qualification.status') IS NOT 'qualified' ORDER BY sequence LIMIT 1`;
  const status = Effect.fn("InboxQualificationService.status")(
    function* () {
      const rows = yield* sql<{
        category: string | null;
        count: number;
        errors: number;
        input_tokens: number;
        output_tokens: number;
      }>`SELECT
      json_extract(payload_json,'$.qualification.category') AS category, COUNT(*) AS count,
      SUM(CASE WHEN json_extract(payload_json,'$.qualificationAttempt.status')='error' THEN 1 ELSE 0 END) AS errors,
      COALESCE(SUM(json_extract(payload_json,'$.qualification.usage.input_tokens')),0) AS input_tokens,
      COALESCE(SUM(json_extract(payload_json,'$.qualification.usage.output_tokens')),0) AS output_tokens
      FROM message_inbox GROUP BY category`;
      const categories = {
        no_action: 0,
        information: 0,
        personal_action: 0,
        technical_action: 0,
        unsure: 0,
      };
      let total = 0,
        errors = 0,
        input_tokens = 0,
        output_tokens = 0;
      for (const row of rows) {
        total += row.count;
        errors += row.errors;
        input_tokens += row.input_tokens;
        output_tokens += row.output_tokens;
        if (row.category !== null && Object.hasOwn(categories, row.category))
          categories[row.category as keyof typeof categories] = row.count;
      }
      const qualified = Object.values(categories).reduce((a, b) => a + b, 0);
      const [first] = yield* head;
      const entry = first ? yield* decodeEntry(first.payload_json) : null;
      return {
        enabled,
        total,
        qualified,
        remaining: total - qualified,
        errors,
        categories,
        usage: { input_tokens, output_tokens },
        head:
          first && entry
            ? {
                id: first.id,
                sequence: first.sequence,
                state: !entry.context
                  ? ("waiting_context" as const)
                  : (entry.qualificationAttempt?.status ?? ("pending" as const)),
                ...(entry.qualificationAttempt ? { attempt: entry.qualificationAttempt } : {}),
              }
            : null,
      };
    },
    Effect.mapError((cause) => new InboxQualificationError({ cause })),
  );
  const setEnabled = Effect.fn("InboxQualificationService.setEnabled")(
    function* (value: boolean) {
      yield* fs.writeFileString(controlPath + ".next", yield* encodeControl({ enabled: value }), {
        mode: 0o600,
      });
      yield* fs.rename(controlPath + ".next", controlPath);
      enabled = value;
      return yield* status();
    },
    lock.withPermits(1),
    Effect.mapError((cause) => new InboxQualificationError({ cause })),
  );
  const processNext = Effect.fn("InboxQualificationService.processNext")(
    function* () {
      if (!enabled) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* head;
          if (!row) return null;
          const entry = yield* decodeEntry(row.payload_json);
          // The collectors enrich after ingestion. Never race their in-progress context fetch.
          if (
            !entry.context ||
            (entry.qualificationAttempt && entry.qualificationAttempt.nextAttemptAt > now)
          )
            return null;
          const attempt = {
            status: "processing" as const,
            token: yield* crypto.randomUUIDv4,
            attempts: (entry.qualificationAttempt?.attempts ?? 0) + 1,
            nextAttemptAt: DateTime.formatIso(
              DateTime.add(DateTime.makeUnsafe(now), { seconds: 120 }),
            ),
            error: null,
          };
          const encoded = yield* encodeAttempt(attempt);
          const updated =
            yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.qualificationAttempt',json(${encoded}))
        WHERE id=${entry.id} AND payload_json=${row.payload_json} RETURNING id`;
          return updated.length ? { entry, attempt } : null;
        }),
      );
      if (!claimed) return;
      const { entry, attempt } = claimed;
      const result = yield* jev.evaluate(entry).pipe(
        Effect.flatMap((raw) =>
          decodeResponse(raw).pipe(Effect.mapError(() => new Jev.JevError({ reason: "format" }))),
        ),
        Effect.flatMap((response) => {
          const p = response.answers.qualification;
          if (
            response.model !== "jev-1.14.0" ||
            p.probabilities[p.choice] < Math.max(...Object.values(p.probabilities)) - 0.000001
          )
            return Effect.fail(new Jev.JevError({ reason: "format" }));
          return Effect.succeed(response);
        }),
        Effect.result,
      );
      const finished = DateTime.formatIso(yield* DateTime.now);
      if (result._tag === "Failure") {
        const delay = Math.min(
          1800,
          Math.max(
            result.failure.retryAfterSeconds ?? 0,
            result.failure.reason === "configuration" || result.failure.reason === "limit"
              ? 1800
              : 30 * 2 ** Math.min(attempt.attempts - 1, 6),
          ),
        );
        const encoded = yield* encodeAttempt({
          ...attempt,
          status: "error",
          error: result.failure.reason,
          nextAttemptAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(finished), { seconds: delay }),
          ),
        });
        yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.qualificationAttempt',json(${encoded}))
        WHERE id=${entry.id} AND json_extract(payload_json,'$.qualificationAttempt.token')=${attempt.token}
        AND json_extract(payload_json,'$.qualification.status') IS NOT 'qualified'`;
        return;
      }
      const response = result.success;
      const encoded = yield* encodeQualification({
        version: 1,
        status: "qualified",
        category: response.answers.qualification.choice,
        probabilities: response.answers.qualification.probabilities,
        confidence: response.answers.qualification.confidence,
        model: response.model,
        qualifiedAt: finished,
        usage: response.usage,
      });
      yield* sql`UPDATE message_inbox SET payload_json=json_remove(json_set(payload_json,'$.qualification',json(${encoded})),'$.qualificationAttempt')
      WHERE id=${entry.id} AND json_extract(payload_json,'$.qualificationAttempt.token')=${attempt.token}
      AND json_extract(payload_json,'$.qualification.status') IS NOT 'qualified'`;
    },
    lock.withPermits(1),
    Effect.mapError((cause) => new InboxQualificationError({ cause })),
  );
  return InboxQualificationService.of({ status, setEnabled, processNext });
});
export const layer = Layer.effect(InboxQualificationService, make);
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* InboxQualificationService;
    yield* RuntimeAdmission.admit(service.processNext()).pipe(
      Effect.catch(() =>
        Effect.logWarning("Inbox qualification storage unavailable; queue retained."),
      ),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
  }),
);
