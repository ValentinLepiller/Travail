import { WS_METHODS, type InboxSubject, type EnvironmentId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export function useInboxSubjects(environmentId: EnvironmentId) {
  const [getPage] = useState(() =>
    createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
      label: "inbox:subjects",
      tag: WS_METHODS.inboxSubjects,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  );
  const [pagination, setPagination] = useState({
    subjects: [] as ReadonlyArray<InboxSubject>,
    after: undefined as number | undefined,
  });
  const atom = useMemo(
    () =>
      getPage({
        environmentId,
        input: { ...(pagination.after === undefined ? {} : { after: pagination.after }), limit: 5 },
      }),
    [environmentId, getPage, pagination.after],
  );
  const query = useEnvironmentQuery(atom);
  const after = pagination.after;
  const subjects = useMemo(() => {
    const entries = new Map(pagination.subjects.map((subject) => [subject.id, subject]));
    for (const subject of query.data?.subjects ?? []) entries.set(subject.id, subject);
    return [...entries.values()];
  }, [pagination.subjects, query.data]);
  const loadNext = useCallback(() => {
    const next = query.data?.nextCursor;
    if (!query.isSuccess || query.isPending || next == null || next === after) return;
    if (after !== undefined && subjects.length === pagination.subjects.length) return;
    setPagination((current) => (current.after === after ? { subjects, after: next } : current));
  }, [after, subjects, pagination.subjects.length, query.data, query.isPending, query.isSuccess]);
  return {
    subjects,
    isPending: query.isPending || (!query.data && !query.error),
    error: query.error,
    loadNext,
    retry: query.refresh,
  };
}
export function useInboxSubjectEntries(environmentId: EnvironmentId, subjectId: string) {
  const [after, setAfter] = useState<number | undefined>();
  const [getPage] = useState(() =>
    createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
      label: "inbox:subjectEntries",
      tag: WS_METHODS.inboxSubjectEntries,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
  );
  const atom = useMemo(
    () =>
      getPage({
        environmentId,
        input: { subjectId, ...(after === undefined ? {} : { after }), limit: 5 },
      }),
    [environmentId, getPage, subjectId, after],
  );
  return { ...useEnvironmentQuery(atom), setAfter };
}

export const applyInboxSubjectAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "inbox:subjectAction",
  tag: WS_METHODS.inboxSubjectAction,
});
