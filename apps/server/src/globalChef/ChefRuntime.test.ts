import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Agents from "../autonomousAgents/AutonomousAgentService.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Source from "../inbox/InboxContextSource.ts";
import * as Runtime from "./ChefRuntime.ts";

it.effect(
  "existing dossier headers survive settings changes and notifications target responsible Chefs only",
  () => {
    let sent = 0;
    return Effect.gen(function* () {
      const runtime = yield* Runtime.ChefRuntime,
        sql = yield* SqlClient.SqlClient;
      yield* runtime.ensureDossier(
        {
          enabled: true,
          projectId: ProjectId.make("new-host"),
          modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "new-model" },
        },
        {
          id: "alpha",
          threadId: ThreadId.make("chef-dossier:alpha"),
          subjectId: "alpha",
          title: "Sujet",
          state: "pending",
          requestId: null,
          error: null,
          updatedAt: "",
        },
      );
      yield* sql`INSERT INTO autonomous_agents(id,payload_json) VALUES('recipient','{"kind":"task","projectId":"project"}')`;
      expect(
        (yield* runtime
          .notify("recipient", "stable-notice", "Nouveauté", {
            projectId: "project",
            chantierId: null,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(sent).toBe(0);
      yield* sql`UPDATE autonomous_agents SET payload_json='{"kind":"chef","projectId":"other"}' WHERE id='recipient'`;
      expect(
        (yield* runtime
          .notify("recipient", "stable-notice", "Nouveauté", {
            projectId: "project",
            chantierId: null,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("conflict");
      yield* sql`UPDATE autonomous_agents SET payload_json='{"kind":"chef","projectId":"project"}' WHERE id='recipient'`;
      yield* runtime.notify("recipient", "stable-notice", "Nouveauté", {
        projectId: "project",
        chantierId: null,
      });
      expect(sent).toBe(1);
    }).pipe(
      Effect.provide(
        Runtime.layer.pipe(
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
              dispatch: () => Effect.die("Existing header must not be created again"),
            }),
          ),
          Layer.provide(
            Layer.mock(Agents.AutonomousAgentService)({
              command: () =>
                Effect.sync(() => {
                  sent++;
                }),
            }),
          ),
          Layer.provide(Layer.mock(Generation.TextGeneration)({})),
          Layer.provide(Layer.mock(Source.InboxContextSource)({})),
          Layer.provide(Layer.mock(Registry.ProviderInstanceRegistry)({})),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    );
  },
);
