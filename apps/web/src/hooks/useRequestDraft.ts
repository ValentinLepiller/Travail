import type { AgentRequest } from "@t3tools/contracts";
import { useStore } from "zustand";
import { requestPageState } from "../state/workPageState";

export function useRequestDraft(
  environmentId: string,
  request: Pick<AgentRequest, "id" | "version">,
  field: "drafts" | "temporaryDrafts" = "drafts",
) {
  const page = requestPageState(environmentId);
  const draft = useStore(page, (state) => state[field]?.[request.id]);
  const text = draft?.version === request.version ? draft.text : "";
  const setText = (text: string) => {
    page.setState((state) => ({
      ...state,
      [field]: { ...state[field], [request.id]: { version: request.version, text } },
    }));
  };
  const clearSubmitted = () => {
    page.setState((state) => {
      const draft = state[field]?.[request.id];
      if (draft?.version !== request.version || draft.text !== text) return state;
      const { [request.id]: _, ...drafts } = state[field] ?? {};
      return { ...state, [field]: drafts };
    });
  };
  return { text, setText, clearSubmitted };
}
