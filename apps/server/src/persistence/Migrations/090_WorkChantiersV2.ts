import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_chantier_project_policies (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE work_chantier_subject_cursors (chantier_id TEXT NOT NULL, subject_id TEXT NOT NULL, last_entry_row INTEGER NOT NULL, PRIMARY KEY(chantier_id,subject_id))`;
  yield* sql`CREATE TABLE work_chantier_notifications (chantier_id TEXT NOT NULL, notification_id TEXT NOT NULL, payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chantier_id, notification_id))`;
});
