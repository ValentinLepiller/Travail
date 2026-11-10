import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_json TEXT`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_reason TEXT`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_updated_at TEXT`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_model TEXT`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_uncertain INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_next_at TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN context_error TEXT`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN task_link_kind TEXT`;
  yield* sql`UPDATE inbox_subjects SET task_link_kind='created' WHERE task_id IS NOT NULL`;
});
