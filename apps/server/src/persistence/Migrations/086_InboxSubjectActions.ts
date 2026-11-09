import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN action_version INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN task_id TEXT`;
  yield* sql`CREATE INDEX inbox_subjects_task ON inbox_subjects(task_id) WHERE task_id IS NOT NULL`;
  yield* sql`CREATE TABLE inbox_subject_actions (
    request_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES inbox_subjects(id),
    input_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE inbox_subject_task_sources (
    subject_id TEXT NOT NULL REFERENCES inbox_subjects(id),
    entry_id TEXT NOT NULL REFERENCES message_inbox(id), task_id TEXT NOT NULL,
    linked_at TEXT NOT NULL, PRIMARY KEY(subject_id,entry_id,task_id)
  )`;
});
