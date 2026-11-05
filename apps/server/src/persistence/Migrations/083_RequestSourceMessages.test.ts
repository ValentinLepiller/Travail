import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "upgrades existing Gmail identities without inventing message content or losing data",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`INSERT INTO work_task_gmail_messages (account_email, message_id, task_id)
      VALUES ('account@example.com', 'original-message', 'original-task')`;
      yield* runMigrations();
      expect(yield* sql`SELECT * FROM work_task_gmail_messages`).toEqual([
        {
          account_email: "account@example.com",
          message_id: "original-message",
          task_id: "original-task",
          payload_json: null,
        },
      ]);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
