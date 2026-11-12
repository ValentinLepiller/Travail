import { EnvironmentId, ThreadId, type AgentRequest } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../../lib/storage";
import { requestPageState } from "../../state/workPageState";

const rpc = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/entities", () => ({ useProject: () => null, useThreadShell: () => null }));
vi.mock("../../state/agentRequests", () => ({
  agentRequests: vi.fn(),
  respondToRequest: { permissionAtom: vi.fn() },
  retryRequestDelivery: { permissionAtom: vi.fn() },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => rpc.respond }));
vi.mock("../../hooks/useWorkPageEnvironmentSelection", () => ({
  useWorkPageEnvironmentSelection: vi.fn(),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => "Send failed",
}));
vi.mock("../globalChef/MemoryScope", () => ({ MemoryScope: () => null, memoryActionLabels: {} }));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("./RequestTemporaryChat", () => ({ RequestTemporaryChat: () => null }));
import { RequestCard } from "./AgentRequestsPage";

const environmentId = EnvironmentId.make("draft-test");
const request: AgentRequest = {
  id: "request",
  threadId: ThreadId.make("thread"),
  version: 1,
  kind: "text",
  context: "Test",
  question: "Question",
  details: "",
  action: null,
  status: "pending",
  response: "",
  history: [],
  actionStatus: "idle",
  delivery: "none",
  createdAt: "2026-11-05T10:00:00Z",
  updatedAt: "2026-11-05T10:00:00Z",
};
let renderer: ReactTestRenderer;
function mount(value = request) {
  act(() => {
    renderer = create(<RequestCard request={value} environmentId={environmentId} inline />);
  });
}
function type(text: string) {
  act(() => renderer.root.findByType("textarea").props.onChange({ target: { value: text } }));
}
function text() {
  return renderer.root.findByType("textarea").props.value;
}
function send() {
  renderer.root
    .findAllByType("button")
    .find((button) => button.props.children === "Envoyer la réponse")!
    .props.onClick();
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { localStorage: createMemoryStorage() });
  requestPageState(environmentId).setState({ drafts: {} });
  rpc.respond.mockReset();
  mount();
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("restores the response after the card is unmounted and reopened", () => {
  type("Texte commencé\nnon envoyé");
  act(() => renderer.unmount());
  mount();
  expect(text()).toBe("Texte commencé\nnon envoyé");
});
it("keeps responses separate and does not reuse one after a request revision", () => {
  type("Réponse A");
  act(() =>
    renderer.update(
      <RequestCard request={{ ...request, id: "other" }} environmentId={environmentId} inline />,
    ),
  );
  expect(text()).toBe("");
  type("Réponse B");
  act(() =>
    renderer.update(<RequestCard request={request} environmentId={environmentId} inline />),
  );
  expect(text()).toBe("Réponse A");
  act(() =>
    renderer.update(
      <RequestCard request={{ ...request, version: 2 }} environmentId={environmentId} inline />,
    ),
  );
  expect(text()).toBe("");
});
it.each(["Success", "Failure"])(
  "clears only a successfully submitted response (%s)",
  async (_tag) => {
    type("Texte à envoyer");
    const response = Promise.resolve({ _tag });
    rpc.respond.mockReturnValue(response);
    await act(async () => {
      send();
      await response;
    });
    act(() => renderer.unmount());
    mount();
    expect(text()).toBe(_tag === "Success" ? "" : "Texte à envoyer");
  },
);
it("keeps text edited while the previous response is being submitted", async () => {
  type("Ancien texte");
  let resolve!: (value: { _tag: string }) => void;
  const response = new Promise<{ _tag: string }>((complete) => {
    resolve = complete;
  });
  rpc.respond.mockReturnValue(response);
  act(() => send());
  type("Nouveau brouillon");
  await act(async () => {
    resolve({ _tag: "Success" });
    await response;
  });
  expect(text()).toBe("Nouveau brouillon");
});
