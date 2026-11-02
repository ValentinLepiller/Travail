import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_chantiers (id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX work_tasks_chantier ON work_tasks (json_extract(payload_json, '$.chantierId'))`;
  yield* sql`CREATE UNIQUE INDEX work_chantiers_thread ON work_chantiers (json_extract(payload_json, '$.orchestratorThreadId'))`;
});
