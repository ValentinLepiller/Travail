import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE autonomous_agent_decisions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE autonomous_agents (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE autonomous_agent_runs (thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, completed INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, task_id TEXT, request_id INTEGER)`;
  yield* sql`CREATE INDEX autonomous_runs_agent ON autonomous_agent_runs(agent_id, started_at)`;
  yield* sql`CREATE TABLE autonomous_agent_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, sender_thread_id TEXT NOT NULL, text TEXT NOT NULL, response TEXT, claimed_thread_id TEXT)`;
});
