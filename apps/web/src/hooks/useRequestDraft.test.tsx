import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../lib/storage";
import { requestPageState } from "../state/workPageState";
import { useRequestDraft } from "./useRequestDraft";

let draft: ReturnType<typeof useRequestDraft>;
let renderer: ReactTestRenderer;
function Probe({ field }: { field: "drafts" | "temporaryDrafts" }) {
  draft = useRequestDraft("draft-hook-test", { id: "request", version: 2 }, field);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { localStorage: createMemoryStorage() });
  requestPageState("draft-hook-test").setState({ drafts: {}, temporaryDrafts: {} });
  act(() => {
    renderer = create(<Probe field="drafts" />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
it("keeps the response separate from the unsent temporary question when reopening", () => {
  act(() => draft.setText("Réponse à la demande"));
  act(() => renderer.update(<Probe field="temporaryDrafts" />));
  expect(draft.text).toBe("");
  act(() => draft.setText("Question à l’assistant"));
  act(() => renderer.unmount());
  act(() => {
    renderer = create(<Probe field="temporaryDrafts" />);
  });
  expect(draft.text).toBe("Question à l’assistant");
  act(() => renderer.update(<Probe field="drafts" />));
  expect(draft.text).toBe("Réponse à la demande");
});
it("does not discard a temporary question edited while the previous one was sent", () => {
  act(() => renderer.update(<Probe field="temporaryDrafts" />));
  act(() => draft.setText("Première question"));
  const submitted = draft.clearSubmitted;
  act(() => draft.setText("Nouvelle question"));
  act(() => submitted());
  expect(draft.text).toBe("Nouvelle question");
  act(() => draft.clearSubmitted());
  expect(draft.text).toBe("");
});
