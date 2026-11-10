import {
  SlackTaskMessage,
  GmailTaskMessage,
  InboxSource,
  InboxMessage,
  InboxListInput,
  InboxReadInput,
  InboxPage,
  InboxContext,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class InboxStorageError extends Schema.TaggedError<InboxStorageError>()(
  "InboxStorageError",
  {
    operation: Schema.Literals(["store", "list", "read", "context"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `L’accès à l’inbox a échoué (${this.operation}).`;
  }
}
export class InboxMessageNotFound extends Schema.TaggedError<InboxMessageNotFound>()(
  "InboxMessageNotFound",
  {},
) {
  override get message(): string {
    return "Ce message est introuvable dans l’inbox.";
  }
}

export class MessageInbox extends Context.Service<
  MessageInbox,
  {
    readonly ingestGmail: (
      message: GmailTaskMessage,
      context?: InboxContext,
    ) => Effect.Effect<"created" | "duplicate", InboxStorageError>;
    readonly ingestSlack: (
      message: SlackTaskMessage,
      context?: InboxContext,
    ) => Effect.Effect<"created" | "duplicate", InboxStorageError>;
    readonly collectionState: (input: {
      kind: "gmail" | "slack";
      identity: string;
      after: string;
      before: string;
    }) => Effect.Effect<
      { knownIds: ReadonlyArray<string>; recovery: ReadonlyArray<typeof InboxSource.Type> },
      InboxStorageError
    >;
    readonly setContext: (
      id: string,
      context: InboxContext,
    ) => Effect.Effect<void, InboxStorageError | InboxMessageNotFound>;
    readonly list: (
      input: typeof InboxListInput.Type,
    ) => Effect.Effect<typeof InboxPage.Type, InboxStorageError>;
    readonly read: (
      input: typeof InboxReadInput.Type,
    ) => Effect.Effect<typeof InboxMessage.Type, InboxStorageError | InboxMessageNotFound>;
  }
>()("t3/inbox/MessageInbox") {}

const validateSource = Schema.decodeEffect(InboxSource);
const validateListInput = Schema.decodeEffect(InboxListInput);
const encode = Schema.encodeEffect(Schema.fromJsonString(InboxMessage));
const decode = Schema.decodeEffect(Schema.fromJsonString(InboxMessage));
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(InboxContext));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = Effect.fn("MessageInbox.store")(
    function* (input: typeof InboxSource.Type, context?: InboxContext) {
      const source = yield* validateSource(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          let id: string;
          let url: string;
          // The collectors replay an overlap. Preserve the old ingestion ledger,
          // including identities whose tasks have since been deleted.
          if (source.kind === "gmail") {
            const message = source.message;
            id = `gmail:${message.accountEmail}:${message.id}`;
            const previous = yield* sql`SELECT 1 FROM work_task_gmail_messages
              WHERE account_email = ${message.accountEmail} AND message_id = ${message.id}
              UNION ALL SELECT 1 FROM message_inbox WHERE id = ${id} LIMIT 1`;
            if (previous.length) {
              if (context) yield* repairContext(id, context);
              return "duplicate" as const;
            }
            url = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(message.accountEmail)}#all/${message.id}`;
          } else {
            const message = source.message;
            id = `slack:${message.workspaceId}:${message.channelId}:${message.ts}`;
            const previous = yield* sql`SELECT 1 FROM work_task_slack_messages
              WHERE workspace_id = ${message.workspaceId} AND channel_id = ${message.channelId} AND message_ts = ${message.ts}
              UNION ALL SELECT 1 FROM message_inbox WHERE id = ${id} LIMIT 1`;
            if (previous.length) {
              if (context) yield* repairContext(id, context);
              return "duplicate" as const;
            }
            url = `https://app.slack.com/archives/${message.channelId}/p${message.ts.replace(".", "")}`;
          }
          const payload = yield* encode({
            id,
            url,
            source,
            collectedAt: DateTime.formatIso(yield* DateTime.now),
            ...(context ? { context } : {}),
          });
          const inserted =
            yield* sql`INSERT INTO message_inbox (id, payload_json) VALUES (${id}, ${payload})
        ON CONFLICT(id) DO NOTHING RETURNING id`;
          return inserted.length ? ("created" as const) : ("duplicate" as const);
        }),
      );
    },
    Effect.mapError((cause) => new InboxStorageError({ operation: "store", cause })),
  );
  const repairContext = (id: string, context: InboxContext) =>
    Effect.gen(function* () {
      const encoded = yield* encodeContext(context);
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.context',json(${encoded}))
      WHERE id=${id} AND json_type(payload_json,'$.context') IS NULL
      AND json_extract(payload_json,'$.qualification.status') IS NOT 'qualified'`;
    });
  const collectionState = Effect.fn("MessageInbox.collectionState")(
    function* (input: {
      kind: "gmail" | "slack";
      identity: string;
      after: string;
      before: string;
    }) {
      const gmail = input.kind === "gmail";
      const owner = gmail
        ? sql`json_extract(payload_json,'$.source.message.accountEmail')`
        : sql`json_extract(payload_json,'$.source.message.workspaceId')`;
      const time = gmail
        ? sql`json_extract(payload_json,'$.source.message.receivedAt')`
        : sql`json_extract(payload_json,'$.source.message.ts')`;
      const key = gmail
        ? sql`json_extract(payload_json,'$.source.message.id')`
        : sql`json_extract(payload_json,'$.source.message.channelId')||':'||json_extract(payload_json,'$.source.message.ts')`;
      const legacy = gmail
        ? sql`SELECT message_id AS id FROM work_task_gmail_messages WHERE account_email=${input.identity}`
        : sql`SELECT channel_id||':'||message_ts AS id FROM work_task_slack_messages WHERE workspace_id=${input.identity}`;
      const known = yield* sql<{
        id: string;
      }>`${legacy} UNION SELECT ${key} AS id FROM message_inbox
      WHERE json_extract(payload_json,'$.source.kind')=${input.kind} AND ${owner}=${input.identity}
      AND json_type(payload_json,'$.context') IS NOT NULL AND ${time}>=${input.after} AND ${time}<=${input.before} LIMIT 2001`;
      if (known.length > 2000)
        return yield* new InboxStorageError({
          operation: "list",
          cause: "Collection identity budget exceeded",
        });
      const missing = yield* sql<{ payload_json: string }>`SELECT payload_json FROM message_inbox
      WHERE json_extract(payload_json,'$.source.kind')=${input.kind} AND ${owner}=${input.identity}
      AND json_type(payload_json,'$.context') IS NULL AND json_extract(payload_json,'$.qualification.status') IS NOT 'qualified'
      ORDER BY sequence LIMIT 1`;
      return {
        knownIds: known.map((row) => row.id),
        recovery: yield* Effect.forEach(missing, (row) =>
          decode(row.payload_json).pipe(Effect.map((entry) => entry.source)),
        ),
      };
    },
    Effect.mapError((cause) => new InboxStorageError({ operation: "list", cause })),
  );
  const list = Effect.fn("MessageInbox.list")(
    function* (input: typeof InboxListInput.Type) {
      const { after, order = "asc", limit = 20, processed } = yield* validateListInput(input);
      const cursor =
        after === undefined
          ? sql`1=1`
          : order === "desc"
            ? sql`sequence < ${after}`
            : sql`sequence > ${after}`;
      const filter =
        processed === undefined
          ? sql`1=1`
          : sql`(
        json_extract(payload_json,'$.qualification.category') IS 'no_action'
        OR EXISTS (SELECT 1 FROM inbox_subject_entries e WHERE e.entry_id=message_inbox.id)
      ) = ${Number(processed)}`;
      const rows = yield* sql<{
        sequence: number;
        payload_json: string;
      }>`SELECT sequence, payload_json
      FROM message_inbox WHERE ${cursor} AND ${filter} ORDER BY sequence ${order === "desc" ? sql`DESC` : sql`ASC`} LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      return {
        messages: yield* Effect.forEach(page, (row) => decode(row.payload_json)),
        nextCursor: rows.length > limit ? page[page.length - 1]!.sequence : null,
      };
    },
    Effect.mapError((cause) => new InboxStorageError({ operation: "list", cause })),
  );
  const read = Effect.fn("MessageInbox.read")(function* (input: typeof InboxReadInput.Type) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM message_inbox WHERE id = ${input.id}`.pipe(
      Effect.mapError((cause) => new InboxStorageError({ operation: "read", cause })),
    );
    if (!rows[0]) return yield* new InboxMessageNotFound({});
    return yield* decode(rows[0].payload_json).pipe(
      Effect.mapError((cause) => new InboxStorageError({ operation: "read", cause })),
    );
  });
  const setContext = Effect.fn("MessageInbox.setContext")(function* (
    id: string,
    context: InboxContext,
  ) {
    const rows = yield* Effect.gen(function* () {
      const payload = yield* encodeContext(context);
      return yield* sql`UPDATE message_inbox SET payload_json = json_set(payload_json, '$.context', json(${payload}))
        WHERE id = ${id} RETURNING id`;
    }).pipe(Effect.mapError((cause) => new InboxStorageError({ operation: "context", cause })));
    if (!rows.length) return yield* new InboxMessageNotFound({});
  });
  return MessageInbox.of({
    ingestGmail: (message, context) => store({ kind: "gmail", message }, context),
    ingestSlack: (message, context) => store({ kind: "slack", message }, context),
    collectionState,
    list,
    read,
    setContext,
  });
});
export const layer = Layer.effect(MessageInbox, make);
