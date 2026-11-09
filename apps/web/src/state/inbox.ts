import { WS_METHODS, type EnvironmentId, type InboxMessage } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

// A mounted list owns its queries: remounting for refresh or another machine starts fresh.
export function useInboxMessages(environmentId: EnvironmentId) {
  const [getPage] = useState(() =>
    createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
      label: "inbox:list",
      tag: WS_METHODS.inboxList,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  );
  const [pagination, setPagination] = useState({
    messages: [] as ReadonlyArray<InboxMessage>,
    after: undefined as number | undefined,
  });
  const pageAtom = useMemo(
    () =>
      getPage({
        environmentId,
        input: {
          ...(pagination.after === undefined ? {} : { after: pagination.after }),
          order: "desc",
          limit: 5,
        },
      }),
    [environmentId, getPage, pagination.after],
  );
  const query = useEnvironmentQuery(pageAtom);
  const after = pagination.after;
  const messages = useMemo(() => {
    const entries = new Map(pagination.messages.map((entry) => [entry.id, entry]));
    for (const entry of query.data?.messages ?? []) entries.set(entry.id, entry);
    return [...entries.values()];
  }, [pagination.messages, query.data]);
  const loadNext = useCallback(() => {
    const next = query.data?.nextCursor;
    if (!query.isSuccess || query.isPending || next == null || next === after) return;
    if (after !== undefined && messages.length === pagination.messages.length) return;
    setPagination((current) => (current.after === after ? { messages, after: next } : current));
  }, [after, messages, pagination.messages.length, query.data, query.isPending, query.isSuccess]);
  return {
    messages,
    isPending: query.isPending || (!query.data && !query.error),
    error: query.error,
    loadNext,
    retry: query.refresh,
  };
}
