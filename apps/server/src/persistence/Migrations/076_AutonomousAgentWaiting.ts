import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE autonomous_agent_runs ADD COLUMN wake_key TEXT`;
  yield* sql`ALTER TABLE autonomous_agent_runs ADD COLUMN waiting_for TEXT CHECK(waiting_for IN ('human', 'agent'))`;
  yield* sql`UPDATE autonomous_agent_runs SET waiting_for = 'human', finished_at = NULL
    WHERE EXISTS (SELECT 1 FROM agent_requests q WHERE json_extract(q.payload_json, '$.threadId') = autonomous_agent_runs.thread_id AND json_extract(q.payload_json, '$.status') IN ('pending','revision'))`;
  yield* sql`CREATE INDEX autonomous_runs_waiting ON autonomous_agent_runs(agent_id, waiting_for)`;
});
