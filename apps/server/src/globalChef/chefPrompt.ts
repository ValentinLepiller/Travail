import type { ChefDossierDetail } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ChefContext } from "./chefContext.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function withinBudget<A>(items: ReadonlyArray<A>, budget: number): ReadonlyArray<A> {
  let bytes = 0;
  for (let index = 0; index < items.length; index++) {
    bytes += Buffer.byteLength(encode(items[index]), "utf8");
    if (bytes > budget) return items.slice(0, index);
  }
  return items;
}

export function preparePromptContext(
  context: ChefContext,
  messages: typeof ChefDossierDetail.Type.messages,
  olderMessages: boolean,
) {
  const {
    tasks: allTasks,
    threads: allThreads,
    sources: allSources,
    linkedTask,
    ...base
  } = context;
  const tasks = withinBudget(
    allTasks.map(({ id, version, title, notes, projectId, chantierId, status, agentThreadId }) => ({
      id,
      version,
      title,
      notes: notes.slice(0, 800),
      notesTruncated: notes.length > 800,
      projectId,
      chantierId,
      status,
      agentThreadId,
    })),
    12_000,
  );
  const threads = withinBudget(
    allThreads.map((t) => ({
      ...t,
      text: t.text.slice(0, 3000),
      truncated: t.truncated || t.text.length > 3000,
    })),
    10_000,
  );
  const sources = withinBudget(allSources, 16_000);
  // Keep the latest message whole, even when it alone exceeds the history budget.
  const recent = withinBudget(messages.toReversed(), 8000);
  const latestUser = messages.findLastIndex((m) => m.role === "user" || m.role === "chef");
  const start = Math.min(
    messages.length - Math.max(1, recent.length),
    latestUser < 0 ? messages.length : latestUser,
  );
  const conversation = messages.slice(Math.max(0, start));
  return {
    ...base,
    linkedTaskId: linkedTask?.id ?? null,
    tasks,
    threads,
    sources,
    conversation,
    searchIncomplete:
      context.searchIncomplete ||
      tasks.length < allTasks.length ||
      threads.length < allThreads.length,
    sourcesIncomplete: context.sourcesIncomplete || sources.length < allSources.length,
    conversationTruncated: olderMessages || conversation.length < messages.length,
  };
}
