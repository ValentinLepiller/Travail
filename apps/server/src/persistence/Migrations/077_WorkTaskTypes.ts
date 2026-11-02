import * as Schema from "effect/Schema";
import { WorkTaskTypesConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
const encode = Schema.encodeEffect(Schema.fromJsonString(WorkTaskTypesConfig));
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE work_task_types (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)`;
  const payload = yield* encode({
    version: 0,
    types: [
      {
        id: "feature",
        name: "Feature",
        prompt:
          "Implémente cette fonctionnalité en respectant les conventions du projet. Vérifie le résultat.",
      },
      {
        id: "fix",
        name: "Fix",
        prompt:
          "Diagnostique et corrige ce problème. Vérifie la correction et les risques de régression.",
      },
    ],
  });
  yield* sql`INSERT INTO work_task_types VALUES (1, ${payload})`;
});
