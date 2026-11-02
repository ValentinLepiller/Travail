import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep message identities after task deletion so a rescan cannot recreate it.
  yield* sql`CREATE TABLE work_task_slack_messages (
    workspace_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    task_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, channel_id, message_ts)
  )`;
  yield* sql`CREATE INDEX work_task_slack_thread ON work_task_slack_messages(workspace_id, channel_id, thread_ts)`;
  yield* sql`CREATE INDEX work_task_slack_task ON work_task_slack_messages(task_id, message_ts)`;
  yield* sql`CREATE TABLE slack_task_collection (
    workspace_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    window_end TEXT,
    cursor TEXT
  )`;
});
