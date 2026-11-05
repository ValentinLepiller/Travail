import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../lib/storage";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", { localStorage: createMemoryStorage() });
});
afterEach(() => vi.unstubAllGlobals());

const taskDraft = {
  id: "task-1",
  expectedVersion: 3,
  title: "",
  notes: "Texte commencé\nà conserver",
  status: "todo" as const,
  projectId: null,
  agentThreadId: null,
  dueDate: null,
};

describe("local work page state", () => {
  it("restores the selected request, archive and versioned drafts after reloading", async () => {
    const { requestPageState } = await import("./workPageState");
    const key = "request-2";
    requestPageState("server-a").setState({
      selected: "request-2",
      archive: true,
      drafts: { [key]: { version: 3, text: "Brouillon\nnon envoyé" } },
    });
    vi.resetModules();
    const reloaded = await import("./workPageState");
    expect(reloaded.requestPageState("server-a").getState()).toEqual({
      selected: "request-2",
      archive: true,
      drafts: { [key]: { version: 3, text: "Brouillon\nnon envoyé" } },
    });
    expect(reloaded.requestPageState("server-b").getState()).toEqual({
      selected: null,
      archive: false,
      drafts: {},
    });
    expect(reloaded.requestPageState("server-a").getState().drafts[key]?.version).toBe(3);
  });

  it("restores an incomplete task editor with the original conflict version and filters", async () => {
    const { taskPageState } = await import("./workPageState");
    taskPageState("server-a").setState({
      editing: taskDraft,
      filter: "review",
      search: "test",
      projectFilter: "project-a",
    });
    vi.resetModules();
    const reloaded = await import("./workPageState");
    expect(reloaded.taskPageState("server-a").getState()).toEqual({
      editing: taskDraft,
      filter: "review",
      search: "test",
      projectFilter: "project-a",
    });
    expect(reloaded.taskPageState("server-b").getState().editing).toBeNull();
    reloaded.taskPageState("server-a").setState({ editing: null });
    vi.resetModules();
    expect(
      (await import("./workPageState")).taskPageState("server-a").getState().editing,
    ).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ selected: 12 }),
    JSON.stringify({ archive: false, selected: null, drafts: { x: 3 } }),
  ])("recovers from malformed saved data: %s", async (raw) => {
    window.localStorage.setItem("travail:request-page:v1:server-a", raw);
    const { requestPageState } = await import("./workPageState");
    const page = requestPageState("server-a");
    expect(page.getState()).toEqual({ selected: null, archive: false, drafts: {} });
    page.setState({ selected: "request-2" });
    vi.resetModules();
    expect((await import("./workPageState")).requestPageState("server-a").getState().selected).toBe(
      "request-2",
    );
  });

  it.each(["access", "quota"])(
    "keeps editing and navigation working after a storage %s failure",
    async (failure) => {
      if (failure === "access") {
        vi.stubGlobal("window", {
          get localStorage() {
            throw new Error("disabled");
          },
        });
      } else {
        vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
      }
      const { requestPageState, taskPageState } = await import("./workPageState");
      const requests = requestPageState("server-a");
      const tasks = taskPageState("server-a");
      expect(() =>
        requests.setState({
          selected: "request-2",
          drafts: { draft: { version: 1, text: "Texte" } },
        }),
      ).not.toThrow();
      expect(() => tasks.setState({ editing: taskDraft })).not.toThrow();
      expect(requestPageState("server-a").getState().drafts.draft?.text).toBe("Texte");
      expect(taskPageState("server-a").getState().editing).toEqual(taskDraft);
      expect(requestPageState("server-b").getState().drafts).toEqual({});
    },
  );
});
