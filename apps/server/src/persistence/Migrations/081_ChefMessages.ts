import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE chef_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    thread_id TEXT,
    created_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    UNIQUE(agent_id, id)
  )`;
  yield* sql`CREATE INDEX chef_messages_agent ON chef_messages(agent_id, sequence)`;
});
