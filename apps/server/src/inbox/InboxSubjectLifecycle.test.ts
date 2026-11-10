import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";

it.effect(
  "upgrades acknowledged subjects without swallowing later entries or changing tasks and source payloads",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 85 });
      const sql = yield* SqlClient.SqlClient;
      for (const [id, status] of [
        ["open", "todo"],
        ["closed", "done"],
      ] as const) {
        yield* sql`INSERT INTO work_tasks(id,version,payload_json) VALUES(${id},1,${JSON.stringify({ id, status, updatedAt: "2026-11-09T12:00:00Z" })})`;
      }
      for (const id of ["open", "closed", "ignored"]) {
        yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at,ignored,task_id) VALUES(${id},${id},${id},'',${Number(id === "ignored")},${id === "ignored" ? null : id})`;
        for (const [suffix, at] of [
          ["old", "2026-11-09T10:00:00Z"],
          ["new", "2026-11-09T13:00:00Z"],
        ]) {
          const entry = `${id}-${suffix}`;
          yield* sql`INSERT INTO message_inbox(id,payload_json) VALUES(${entry},${JSON.stringify({ id: entry })})`;
          const linkedAt = id === "ignored" && suffix === "new" ? "2026-11-09T12:00:00Z" : at;
          yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES(${entry},${id},${linkedAt},'{}')`;
        }
        yield* sql`INSERT INTO inbox_subject_actions(request_id,subject_id,input_json,result_json,created_at) VALUES(${id},${id},'{}','{}','2026-11-09T12:00:00Z')`;
      }
      const tasks = yield* sql`SELECT * FROM work_tasks ORDER BY id`,
        messages = yield* sql`SELECT * FROM message_inbox ORDER BY sequence`;
      yield* runMigrations();
      const rows = yield* sql<{
        id: string;
        handled_sequence: number;
        closed_at: string | null;
        ignored: number;
      }>`SELECT id,handled_sequence,closed_at,ignored FROM inbox_subjects ORDER BY sequence`;
      expect(rows).toEqual([
        { id: "open", handled_sequence: 1, closed_at: null, ignored: 0 },
        { id: "closed", handled_sequence: 3, closed_at: "2026-11-09T12:00:00Z", ignored: 0 },
        { id: "ignored", handled_sequence: 5, closed_at: null, ignored: 0 },
      ]);
      expect(yield* sql`SELECT * FROM work_tasks ORDER BY id`).toEqual(tasks);
      expect(yield* sql`SELECT * FROM message_inbox ORDER BY sequence`).toEqual(messages);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
