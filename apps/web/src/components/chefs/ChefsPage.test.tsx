// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ allowed: true, command: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../hooks/useEnvironmentSelection", () => ({
  useEnvironmentSelection: () => ({ environmentId: "test", environments: [] }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/autonomousAgents", () => ({
  autonomousAgents: () => "agents",
  autonomousAgentDetail: () => "detail",
  commandAutonomousAgent: { permissionAtom: () => "permission" },
}));
vi.mock("../../state/agentRequests", () => ({ agentRequests: () => "requests" }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data:
      query === "agents"
        ? [{ id: "chef-test", name: "Chef test", kind: "chef", status: "paused", paused: true }]
        : query === "detail"
          ? { history: [], chat: [], memory: "" }
          : [],
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../agentRequests/AgentRequestsPage", () => ({ RequestCard: () => null }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../../env", () => ({ isElectron: false }));

import { ChefsPage } from "./ChefsPage";

let root: Root;
let container: HTMLDivElement;

function editor() {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message au Chef"]')!;
}

async function write(text: string) {
  const input = editor();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(() => editor().dispatchEvent(event));
  return event;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.command.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<ChefsPage />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Chef message keyboard", () => {
  it("sends the whole multiline draft once with Enter and clears it after success", async () => {
    await write("Première ligne\n\nDernière ligne");
    expect((await press()).defaultPrevented).toBe(true);
    expect(state.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: "test",
      input: {
        type: "message",
        id: "chef-test",
        messageId: expect.any(String),
        text: "Première ligne\n\nDernière ligne",
      },
    });
    expect(editor().value).toBe("");
  });

  it("leaves Shift+Enter to native line insertion without sending", async () => {
    await write("Première ligne");
    expect((await press({ shiftKey: true })).defaultPrevented).toBe(false);
    expect(state.command).not.toHaveBeenCalled();
  });

  it("inserts Ctrl+Enter at the caret, replaces selection and sends the resulting lines", async () => {
    await write("avant après");
    editor().setSelectionRange(5, 6);
    await press({ ctrlKey: true });
    expect(editor().value).toBe("avant\naprès");
    expect(editor().selectionStart).toBe(6);
    expect(editor().selectionEnd).toBe(6);
    expect(state.command).not.toHaveBeenCalled();
    await press();
    expect(state.command.mock.calls[0]?.[0].input.text).toBe("avant\naprès");
  });

  it("respects the message length limit when inserting a line with Ctrl+Enter", async () => {
    await write("a".repeat(5000));
    await press({ ctrlKey: true });
    expect(editor().value).toHaveLength(5000);
    editor().setSelectionRange(4999, 5000);
    await press({ ctrlKey: true });
    expect(editor().value).toBe("a".repeat(4999) + "\n");
    expect(state.command).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "preserves composition with %j",
    async (options) => {
      await write("変換中");
      expect((await press(options)).defaultPrevented).toBe(false);
      expect(editor().value).toBe("変換中");
      expect(state.command).not.toHaveBeenCalled();
    },
  );

  it.each([{ altKey: true }, { metaKey: true }, { key: "a" }])(
    "leaves unrelated keys untouched: %j",
    async (options) => {
      await write("Brouillon");
      expect((await press(options)).defaultPrevented).toBe(false);
      expect(state.command).not.toHaveBeenCalled();
    },
  );

  it("does not send a held Enter or a blank message", async () => {
    await write("Brouillon");
    expect((await press({ repeat: true })).defaultPrevented).toBe(true);
    expect(editor().value).toBe("Brouillon");
    await write(" \n ");
    await press();
    expect(state.command).not.toHaveBeenCalled();
  });

  it("keeps the draft while sending and prevents another submission", async () => {
    let complete!: () => void;
    state.command.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = () => resolve({ _tag: "Success" });
      }),
    );
    await write("À envoyer");
    await press();
    expect(editor().disabled).toBe(true);
    expect(editor().value).toBe("À envoyer");
    await act(() => editor().form!.requestSubmit());
    expect(state.command).toHaveBeenCalledTimes(1);
    await act(() => complete());
    expect(editor().value).toBe("");
  });

  it("retains the draft and message id when retrying after a failed send", async () => {
    state.command.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail("Erreur de test") });
    await write("À réessayer\navec deux lignes");
    await press();
    expect(editor().value).toBe("À réessayer\navec deux lignes");
    expect(editor().disabled).toBe(false);
    await press();
    expect(state.command).toHaveBeenCalledTimes(2);
    expect(state.command.mock.calls[1]).toEqual(state.command.mock.calls[0]);
    expect(editor().value).toBe("");
  });

  it("does not submit without permission, including through the form", async () => {
    state.allowed = false;
    await act(() => root.render(<ChefsPage key="without-permission" />));
    await write("Brouillon conservé");
    expect(editor().disabled).toBe(true);
    await act(() => editor().form!.requestSubmit());
    expect(state.command).not.toHaveBeenCalled();
    expect(editor().value).toBe("Brouillon conservé");
  });

  it("does not change Enter handling in Chef rules and memory", async () => {
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Règles et mémoire",
    )!;
    await act(() => toggle.click());
    for (const input of container.querySelectorAll("textarea")) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(() => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(state.command).not.toHaveBeenCalled();
  });
});
