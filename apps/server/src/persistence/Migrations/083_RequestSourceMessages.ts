import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE work_task_gmail_messages ADD COLUMN payload_json TEXT`;
  yield* sql`CREATE INDEX request_slack_message_identity ON work_task_slack_messages
    ('slack:' || workspace_id || ':' || channel_id || ':' || message_ts)`;
  yield* sql`CREATE INDEX request_gmail_message_identity ON work_task_gmail_messages
    ('gmail:' || account_email || ':' || message_id)`;
  yield* sql`CREATE INDEX work_tasks_agent_thread ON work_tasks (json_extract(payload_json, '$.agentThreadId'))`;
});
