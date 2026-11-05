import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { hasUnseenCompletion } from "~/components/Sidebar.logic";

export function isThreadUnreadBackground(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  currentRouteThreadKey: string | null,
): boolean {
  if (thread.archivedAt !== null) return false;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  if (threadKey === currentRouteThreadKey) return false;

  return hasUnseenCompletion({ ...thread, lastVisitedAt });
}

export function countUnreadBackgroundThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  threadLastVisitedAtById: Readonly<Record<string, string>>,
  currentRouteThreadKey: string | null,
): number {
  let count = 0;
  for (const thread of threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    // The server watermark wins when the server tracks visits; older servers
    // leave lastVisitedAt undefined and this device's local marker applies.
    const lastVisitedAt = thread.lastVisitedAt ?? threadLastVisitedAtById[threadKey];
    if (isThreadUnreadBackground(thread, lastVisitedAt, currentRouteThreadKey)) {
      count++;
    }
  }
  return count;
}
