import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE chef_global (
    id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL,
    token TEXT, lease_until TEXT NOT NULL DEFAULT '', memory_revision INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO chef_global(id,settings_json) VALUES(1,'{"enabled":false,"projectId":null,"modelSelection":null}')`;
  yield* sql`CREATE TABLE chef_dossiers (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    subject_id TEXT NOT NULL UNIQUE REFERENCES inbox_subjects(id), thread_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    subject_version INTEGER NOT NULL DEFAULT -1, request_id TEXT, error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX chef_dossiers_pending ON chef_dossiers(state,next_at,sequence)`;
  yield* sql`CREATE TABLE chef_dossier_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    dossier_id TEXT NOT NULL REFERENCES chef_dossiers(id), role TEXT NOT NULL,
    text TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX chef_messages_dossier ON chef_dossier_messages(dossier_id,sequence)`;
  yield* sql`CREATE TABLE chef_memory (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL, enabled INTEGER NOT NULL, scope_kind TEXT NOT NULL,
    scope_id TEXT, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX chef_memory_scope ON chef_memory(enabled,scope_kind,scope_id)`;
  yield* sql`CREATE TABLE chef_decisions (
    id TEXT PRIMARY KEY, family_key TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX chef_decisions_family ON chef_decisions(family_key,state)`;
  yield* sql`CREATE TABLE chef_action_receipts (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES chef_decisions(id),
    dossier_id TEXT NOT NULL REFERENCES chef_dossiers(id), payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE chef_notifications (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
    project_id TEXT, chantier_id TEXT,
    delivered INTEGER NOT NULL DEFAULT 0
  )`;
});
