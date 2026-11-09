import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE inbox_subjects (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE inbox_subject_entries (
    entry_id TEXT PRIMARY KEY REFERENCES message_inbox(id),
    subject_id TEXT NOT NULL REFERENCES inbox_subjects(id),
    linked_at TEXT NOT NULL, decision_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX inbox_subject_entries_subject ON inbox_subject_entries(subject_id,entry_id)`;
  yield* sql`CREATE TABLE inbox_subject_worker (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
    entry_id TEXT, token TEXT, next_at TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT
  )`;
  yield* sql`INSERT INTO inbox_subject_worker(id) VALUES(1)`;
});
