import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_request_chats (
    request_id TEXT PRIMARY KEY REFERENCES agent_requests(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL
  )`;
});
