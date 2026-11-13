import {
  ChefError,
  CommandId,
  ThreadId,
  isChefError,
  type ChefDossier,
  type ChefSettings,
  type InboxSource,
  type ChatImageAttachment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Source from "../inbox/InboxContextSource.ts";
import type { SourceInspection } from "../inbox/contextSourcePages.ts";
import * as Agents from "../autonomousAgents/AutonomousAgentService.ts";

export class ChefRuntime extends Context.Service<
  ChefRuntime,
  {
    readonly inspect: (
      source: typeof InboxSource.Type,
      query?: string,
    ) => Effect.Effect<SourceInspection, ChefError>;
    readonly generate: (
      settings: typeof ChefSettings.Type,
      prompt: string,
      attachments?: ReadonlyArray<ChatImageAttachment>,
    ) => Effect.Effect<string, ChefError>;
    readonly ensureDossier: (
      settings: typeof ChefSettings.Type,
      dossier: ChefDossier,
    ) => Effect.Effect<void, ChefError>;
    readonly conversation: (
      id: ThreadId,
    ) => Effect.Effect<{ text: string; truncated: boolean }, ChefError>;
    readonly notify: (
      agentId: string,
      id: string,
      text: string,
      target: { projectId: string | null; chantierId: string | null },
    ) => Effect.Effect<void, ChefError>;
  }
>()("t3/globalChef/ChefRuntime") {}

export const layer = Layer.effect(
  ChefRuntime,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* Threads.ThreadManagementService;
    const registry = yield* Registry.ProviderInstanceRegistry;
    const generation = yield* Generation.TextGeneration;
    const agents = yield* Agents.AutonomousAgentService;
    const sources = yield* Source.InboxContextSource;
    return ChefRuntime.of({
      inspect: (source, query) =>
        sources
          .inspect(source, query)
          .pipe(Effect.mapError((cause) => new ChefError({ reason: "storage", cause }))),
      generate: (settings, prompt, attachments) =>
        Effect.gen(function* () {
          const { modelSelection, projectId } = settings;
          if (!modelSelection || !projectId)
            return yield* new ChefError({ reason: "configuration" });
          const instance = yield* registry.getInstance(modelSelection.instanceId);
          if (!instance?.enabled) return yield* new ChefError({ reason: "configuration" });
          if (attachments?.length && instance.driverKind !== "codex")
            return yield* new ChefError({ reason: "configuration" });
          const [project] = yield* sql<{
            cwd: string;
          }>`SELECT workspace_root AS cwd FROM projection_projects
        WHERE project_id=${projectId} AND deleted_at IS NULL`;
          if (!project) return yield* new ChefError({ reason: "configuration" });
          const reply = yield* generation
            .generateChatReply({ cwd: project.cwd, modelSelection, prompt, attachments })
            .pipe(
              Effect.mapError((cause) => new ChefError({ reason: "model", cause })),
              Effect.timeout("120 seconds"),
            );
          return reply.text;
        }).pipe(
          Effect.mapError((cause) =>
            isChefError(cause) ? cause : new ChefError({ reason: "model", cause }),
          ),
        ),
      ensureDossier: (settings, dossier) =>
        Effect.gen(function* () {
          if (!settings.projectId || !settings.modelSelection)
            return yield* new ChefError({ reason: "configuration" });
          // Existing headers keep their original hosting project when the Chef's settings change.
          const existing = yield* threads.getThreadShell(dossier.threadId);
          if (existing) {
            if (existing.deletedAt !== null) return yield* new ChefError({ reason: "missing" });
            return;
          }
          // A stable command receipt makes a restart between thread creation and dossier processing safe.
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`chef:create:${dossier.id}`),
            threadId: dossier.threadId,
            projectId: settings.projectId,
            title: `Dossier du Chef · ${dossier.title}`,
            modelSelection: settings.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
        }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            isChefError(cause) ? cause : new ChefError({ reason: "storage", cause }),
          ),
        ),
      conversation: (id) =>
        Effect.gen(function* () {
          const shell = yield* threads.getThreadShell(id);
          if (!shell || shell.deletedAt !== null)
            return yield* new ChefError({ reason: "missing" });
          const page = yield* threads.getTimelinePage(id, { view: "messages", limit: 20 });
          const text = page.items
            .flatMap(({ item }) =>
              item.type === "user_message" || item.type === "assistant_message"
                ? [`${item.type}: ${item.text}`]
                : [],
            )
            .join("\n\n");
          return { text: text.slice(0, 12_000), truncated: page.hasMore || text.length > 12_000 };
        }).pipe(
          Effect.mapError((cause) =>
            isChefError(cause) ? cause : new ChefError({ reason: "storage", cause }),
          ),
        ),
      notify: (agentId, id, text, target) =>
        Effect.gen(function* () {
          const recipients = yield* sql`SELECT id FROM autonomous_agents WHERE id=${agentId}
          AND COALESCE(json_extract(payload_json,'$.archived'),0)=0 AND (
            (json_extract(payload_json,'$.kind')='chef' AND json_extract(payload_json,'$.projectId')=${target.projectId})
            OR (json_extract(payload_json,'$.kind')='chantier-chef' AND json_extract(payload_json,'$.chantierId')=${target.chantierId}))`;
          if (!recipients.length) return yield* new ChefError({ reason: "conflict" });
          yield* agents.command({ type: "message", id: agentId, messageId: id, text });
        }).pipe(
          Effect.mapError((cause) =>
            isChefError(cause) ? cause : new ChefError({ reason: "storage", cause }),
          ),
        ),
    });
  }),
);
