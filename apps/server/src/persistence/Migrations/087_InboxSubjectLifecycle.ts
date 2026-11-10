import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN handled_sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE inbox_subjects ADD COLUMN closed_at TEXT`;
  // Legacy receipts have no entry cursor: equal-time entries conservatively remain pending.
  yield* sql`UPDATE inbox_subjects SET handled_sequence=COALESCE((
    SELECT MAX(m.sequence) FROM inbox_subject_entries e JOIN message_inbox m ON m.id=e.entry_id
    WHERE e.subject_id=inbox_subjects.id AND (
      NOT EXISTS (SELECT 1 FROM inbox_subject_actions a WHERE a.subject_id=inbox_subjects.id)
      OR e.linked_at < (SELECT MAX(a.created_at) FROM inbox_subject_actions a WHERE a.subject_id=inbox_subjects.id)
    )
  ),0) WHERE ignored=1 OR task_id IS NOT NULL`;
  yield* sql`UPDATE inbox_subjects SET closed_at=(
    SELECT COALESCE(NULLIF(json_extract(t.payload_json,'$.updatedAt'),''),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    FROM work_tasks t WHERE t.id=inbox_subjects.task_id
  ) WHERE task_id IN (SELECT id FROM work_tasks WHERE json_extract(payload_json,'$.status')='done')`;
  yield* sql`UPDATE inbox_subjects SET ignored=0 WHERE ignored=1 AND closed_at IS NULL AND EXISTS (
    SELECT 1 FROM inbox_subject_entries e JOIN message_inbox m ON m.id=e.entry_id
    WHERE e.subject_id=inbox_subjects.id AND m.sequence>inbox_subjects.handled_sequence
  )`;
});
