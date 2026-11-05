import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A parked run keeps its cards until its outstanding decision has been delivered.
export const reservedWorkTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    thread_id: string;
    task_id: string;
  }>`SELECT DISTINCT r.thread_id, task.value AS task_id
    FROM autonomous_agent_runs r, json_each(json_insert(r.task_ids_json, '$[#]', r.task_id)) task
    WHERE task.value IS NOT NULL AND (
      r.finished_at IS NULL
      OR EXISTS (SELECT 1 FROM agent_requests q WHERE json_extract(q.payload_json, '$.threadId') = r.thread_id
        AND (json_extract(q.payload_json, '$.status') IN ('pending','revision') OR json_extract(q.payload_json, '$.delivery') = 'pending'))
      OR EXISTS (SELECT 1 FROM autonomous_agent_decisions d WHERE d.thread_id = r.thread_id AND d.delivered = 0)
    )`;
});
