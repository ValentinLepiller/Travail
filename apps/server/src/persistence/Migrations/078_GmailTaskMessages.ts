import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_task_gmail_messages (
    account_email TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT NOT NULL,
    PRIMARY KEY(account_email, message_id))`;
  yield* sql`CREATE TABLE gmail_task_collection (
    account_email TEXT PRIMARY KEY, started_at TEXT NOT NULL, checkpoint TEXT NOT NULL,
    window_end TEXT, cursor TEXT)`;
});
