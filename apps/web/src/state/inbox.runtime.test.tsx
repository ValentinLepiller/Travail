// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  InboxListError,
  type InboxMessage,
  type InboxPage,
  type InboxSubjectsPage,
  type InboxSubjectActionInput,
  type InboxSubjectActionResult,
  type InboxSubject,
  type WorkTask,
} from "@t3tools/contracts";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
type RpcSession =
  EnvironmentSupervisor.EnvironmentSupervisor["Service"]["session"] extends SubscriptionRef.SubscriptionRef<
    Option.Option<infer Session>
  >
    ? Session
    : never;
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

const boundary = vi.hoisted(() => ({
  list: null as import("@legendapp/list/react").LegendListRef | null,
  ends: 0,
  runtime: undefined as unknown as typeof import("../connection/runtime").connectionAtomRuntime,
  service: undefined as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
}));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  const service = new Proxy({} as EnvironmentRegistry.EnvironmentRegistry["Service"], {
    get: (_target, key) =>
      boundary.service[key as keyof EnvironmentRegistry.EnvironmentRegistry["Service"]],
  });
  boundary.runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service),
  ) as typeof boundary.runtime;
  return { connectionAtomRuntime: boundary.runtime };
});
vi.mock("./entities", () => ({ useProjects: () => [], useProject: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/tasks">{children}</a>,
}));
vi.mock("../../../../packages/client-runtime/src/state/session.ts", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    createEnvironmentSessionAtoms: () => ({
      sessionStateAtom: Atom.family(() =>
        Atom.make(
          AsyncResult.success({
            authenticated: true,
            scopes: ["orchestration:operate"],
            permissions: ["orchestration:operate"],
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
          }),
        ),
      ),
    }),
  };
});
vi.mock("@legendapp/list/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@legendapp/list/react")>();
  const Actual = original.LegendList;
  return {
    ...original,
    LegendList: (props: ComponentProps<typeof Actual>) => (
      <Actual
        {...props}
        ref={(ref) => {
          boundary.list = ref;
          if (typeof props.ref === "function") props.ref(ref);
          else if (props.ref) props.ref.current = ref;
        }}
        onEndReached={(info) => {
          boundary.ends++;
          props.onEndReached?.(info);
        }}
      />
    ),
  };
});
import { useInboxMessages } from "./inbox";
import { InboxPage as InboxView } from "../components/inbox/InboxPage";
vi.mock("../hooks/useEnvironmentSelection", () => ({
  useEnvironmentSelection: () => ({
    environmentId: EnvironmentId.make("test-inbox"),
    environments: [{ environmentId: EnvironmentId.make("test-inbox"), label: "Test" }],
  }),
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

const environmentId = EnvironmentId.make("test-inbox");
const pageFor = (start: number, nextCursor: number | null): typeof InboxPage.Type => ({
  messages: Array.from({ length: 5 }, (_, i): InboxMessage => ({
    id: `message-${start + i}`,
    collectedAt: "2026-11-08T14:00:00.000Z",
    url: "https://example.com",
    source: {
      kind: "gmail",
      message: {
        accountEmail: "me@example.com",
        id: `${start + i}`,
        threadId: "thread",
        receivedAt: "1793975400.000001",
        sender: "Client",
        subject: `Subject ${start + i}`,
        text: "Hello",
      },
    },
  })),
  nextCursor,
});
const page = pageFor(0, 57);
let registry: AtomRegistry.AtomRegistry, renderer: Root | undefined;
let host: HTMLDivElement;
let view: ReturnType<typeof useInboxMessages>;
let requests: Array<{
  input: { after?: number; limit?: number };
  finish: (page?: typeof InboxPage.Type) => void;
  fail: () => void;
}>;
let subjectRequests: Array<{
  input: { after?: number; limit?: number };
  finish: (page: typeof InboxSubjectsPage.Type) => void;
  fail: () => void;
}>;
let actions: Array<{
  input: InboxSubjectActionInput;
  finish: (result: typeof InboxSubjectActionResult.Type) => void;
}>;
let subjectDecision: typeof InboxSubjectActionResult.Type | undefined;
let subjectTask: WorkTask | null;
let subjectContext: Pick<InboxSubject, "context" | "contextLabel">;
const existingTask: WorkTask = {
  id: "existing",
  title: "Tâche existante",
  notes: "Notes manuelles à conserver",
  status: "review",
  projectId: null,
  agentThreadId: null,
  dueDate: null,
  version: 3,
  createdAt: "",
  updatedAt: "",
};
let controlledSubjects: boolean;
let viewportHeight: number;
let rowHeight: number;
let footerHeight: number;
const resizeObservers = new Set<ControlledResizeObserver>();
class ControlledResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  emit() {
    const entries = [...this.targets].map(
      (target) =>
        ({
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [{ blockSize: target.getBoundingClientRect().height, inlineSize: 800 }],
        }) as unknown as ResizeObserverEntry,
    );
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
  }
}
async function resize(height: number) {
  viewportHeight = height;
  await act(() => {
    for (const observer of resizeObservers) observer.emit();
  });
  await layoutFrames();
}
let disconnect: Effect.Effect<void>, reconnect: Effect.Effect<void>;
let renders: number, streams: number;
let frames: Map<number, FrameRequestCallback>;
async function layoutFrames() {
  for (let i = 0; i < 8; i++) {
    const pending = [...frames.values()];
    frames.clear();
    if (!pending.length) break;
    await act(() => pending.forEach((cb) => cb(performance.now())));
  }
}
function Probe() {
  const value = useInboxMessages(environmentId);
  if (++renders > 40) throw Error("Inbox render budget exceeded");
  useEffect(() => {
    view = value;
  }, [value]);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  viewportHeight = 1200;
  rowHeight = 100;
  footerHeight = 100;
  requests = [];
  actions = [];
  subjectRequests = [];
  controlledSubjects = false;
  subjectDecision = undefined;
  subjectTask = null;
  subjectContext = {};
  boundary.ends = 0;
  renders = 0;
  streams = 0;
  registry = AtomRegistry.make();
  host = document.createElement("div");
  document.body.append(host);
  renderer = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(
      0,
      0,
      800,
      this.style.overflowY === "auto"
        ? viewportHeight
        : this.querySelector("details")
          ? rowHeight
          : footerHeight,
    );
  });
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.style.overflowY === "auto"
      ? viewportHeight
      : this.querySelector("details")
        ? rowHeight
        : footerHeight;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() =>
    Math.max(viewportHeight, boundary.list?.getState().contentLength ?? 0),
  );
});
const setupRuntime = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected" as const,
    desired: true,
    network: "online" as const,
    attempt: 1,
    generation: 1,
  });
  const rpc = {
    initialConfig: Effect.succeed({
      environment: { capabilities: { performanceStatistics: false } },
    }),
    client: {
      [WS_METHODS.workTasksSubscribe]: () => Stream.succeed([subjectTask ?? existingTask]),
      [WS_METHODS.workChantiersSubscribe]: () => Stream.succeed([]),
      [WS_METHODS.inboxSubjectAction]: (input: InboxSubjectActionInput) =>
        Effect.callback<typeof InboxSubjectActionResult.Type>((resume) => {
          actions.push({
            input,
            finish: (result) => {
              subjectDecision = {
                ...result,
                processed: result.processed ?? Boolean(result.ignored || result.taskId),
              };
              resume(Effect.succeed(subjectDecision));
            },
          });
        }),
      [WS_METHODS.inboxSubjects]: (input: {
        after?: number;
        limit?: number;
        processed?: boolean;
      }) =>
        controlledSubjects
          ? Effect.callback<typeof InboxSubjectsPage.Type, InboxListError>((resume) => {
              subjectRequests.push({
                input,
                finish: (page) => resume(Effect.succeed(page)),
                fail: () => resume(Effect.fail(new InboxListError({ cause: "offline" }))),
              });
            })
          : Effect.sync(() => {
              const subject = {
                sequence: 1,
                id: "incident",
                title: "Incident Alpha",
                summary: "Problème, logs et résolution.",
                createdAt: "2026-11-08",
                entries: 2,
                taskId: subjectTask?.id ?? null,
                processed: false,
                ...subjectContext,
                ...subjectDecision,
              };
              return {
                subjects:
                  (subject.closedAt ? true : subject.processed) === input.processed
                    ? [subject]
                    : [],
                nextCursor: null,
              };
            }),
      [WS_METHODS.inboxSubjectEntries]: () =>
        Effect.succeed({ messages: pageFor(0, null).messages.slice(0, 2), nextCursor: null }),
      [WS_METHODS.inboxList]: (input: { after?: number; limit?: number }) =>
        Effect.callback<typeof InboxPage.Type, InboxListError>((resume) => {
          requests.push({
            input,
            finish: (value = page) => resume(Effect.succeed(value)),
            fail: () => resume(Effect.fail(new InboxListError({ cause: "offline" }))),
          });
        }),
    },
  } as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(Option.some(rpc));
  disconnect = SubscriptionRef.set(session, Option.none());
  reconnect = SubscriptionRef.set(session, Option.some(rpc));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    state,
    session,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _id,
    stream,
  ) =>
    Stream.suspend(() => {
      streams++;
      return Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    });
  const service = {
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  boundary.service = service;
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  host.remove();
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function inReact<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    let release!: () => void;
    const flushed = act(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          release();
          await flushed;
        }),
      ),
    );
  });
}

it.effect(
  "settles the first five through the real connection/SWR atoms with one transport request",
  () =>
    Effect.gen(function* () {
      yield* setupRuntime;
      yield* Effect.promise(async () => {
        await act(() =>
          renderer!.render(
            <RegistryContext.Provider value={registry}>
              <Probe />
            </RegistryContext.Provider>,
          ),
        );
      });
      expect(requests).toHaveLength(1);
      yield* Effect.promise(async () => {
        await act(() => requests[0]!.finish());
      });
      expect(view.messages).toHaveLength(5);
      expect(view.isPending).toBe(false);
      expect(requests).toHaveLength(1);
      expect(renders).toBeLessThan(10);
      expect(streams).toBe(1);
    }),
);

const mountInbox = () =>
  Effect.promise(async () => {
    await act(() =>
      renderer!.render(
        <RegistryContext.Provider value={registry}>
          <InboxView />
        </RegistryContext.Provider>,
      ),
    );
  });
const finishPage = (index: number, value: typeof InboxPage.Type) =>
  Effect.promise(async () => {
    await act(() => requests[index]!.finish(value));
    await layoutFrames();
  });

it.effect(
  "shows the first five immediately and fills a tall viewport with serial pages of five",
  () =>
    Effect.gen(function* () {
      yield* setupRuntime;
      yield* mountInbox();
      expect(requests).toHaveLength(1);
      yield* Effect.promise(async () => {
        await act(() => requests[0]!.finish(page));
      });
      expect(host.textContent).toContain("Subject 0");
      expect(host.querySelectorAll("details")).toHaveLength(5);
      yield* Effect.promise(layoutFrames);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.input).toEqual({ after: 57, order: "desc", processed: false, limit: 5 });
      yield* Effect.promise(layoutFrames);
      expect(requests).toHaveLength(2);
      yield* finishPage(1, pageFor(5, 91));
      expect(requests).toHaveLength(3);
      expect(requests[2]!.input).toEqual({ after: 91, order: "desc", processed: false, limit: 5 });
      yield* finishPage(2, pageFor(10, 137));
      expect(boundary.list?.getState().contentLength).toBeGreaterThan(viewportHeight);
      expect(requests).toHaveLength(4);
      yield* finishPage(3, pageFor(15, 173));
      expect(requests).toHaveLength(4);
      expect(requests.every((r) => r.input.limit === 5)).toBe(true);
    }),
);

it.effect("waits for scrolling when filled, and resumes filling when the window grows", () =>
  Effect.gen(function* () {
    viewportHeight = 300;
    yield* setupRuntime;
    yield* mountInbox();
    yield* finishPage(0, page);
    expect(requests).toHaveLength(1);
    yield* Effect.promise(async () => {
      const node = boundary.list!.getScrollableNode() as HTMLElement;
      await act(() => {
        node.scrollTop = 20;
        node.dispatchEvent(new Event("scroll"));
      });
      await layoutFrames();
      await act(() => {
        node.dispatchEvent(new Event("scrollend"));
        node.scrollTop = 150;
        node.dispatchEvent(new Event("scroll"));
      });
      await layoutFrames();
    });
    expect(requests).toHaveLength(2);
    yield* finishPage(1, pageFor(5, 91));
    expect(requests).toHaveLength(2);
    yield* Effect.promise(() => resize(1400));
    expect(requests).toHaveLength(3);
    yield* finishPage(2, pageFor(10, 137));
    expect(requests).toHaveLength(4);
    yield* finishPage(3, pageFor(15, null));
    expect(requests).toHaveLength(4);
  }),
);

it.effect("stops filling on end, errors or a page without progress", () =>
  Effect.gen(function* () {
    yield* setupRuntime;
    yield* mountInbox();
    yield* finishPage(0, page);
    expect(requests).toHaveLength(2);
    yield* Effect.promise(async () => {
      await act(() => requests[1]!.fail());
      await resize(1500);
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain("Subject 0");
    expect(requests).toHaveLength(2);
    yield* Effect.promise(async () => {
      await act(() =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Réessayer"))!
          .click(),
      );
    });
    expect(requests).toHaveLength(3);
    yield* finishPage(2, pageFor(0, 91));
    expect(requests).toHaveLength(3);
    yield* Effect.promise(async () => {
      await act(() =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "Actualiser")!
          .click(),
      );
    });
    expect(requests).toHaveLength(4);
    yield* finishPage(3, pageFor(0, null));
    yield* Effect.promise(() => resize(1800));
    expect(requests).toHaveLength(4);
  }),
);

it.effect("starts exactly once when the real session arrives after mounting", () =>
  Effect.gen(function* () {
    yield* setupRuntime;
    yield* disconnect;
    yield* Effect.promise(async () => {
      await act(() =>
        renderer!.render(
          <RegistryContext.Provider value={registry}>
            <Probe />
          </RegistryContext.Provider>,
        ),
      );
    });
    expect(requests).toHaveLength(0);
    expect(view.isPending).toBe(true);
    yield* inReact(reconnect);
    expect(requests).toHaveLength(1);
    yield* Effect.promise(async () => {
      await act(() => requests[0]!.finish());
    });
    expect(view.messages).toHaveLength(5);
    expect(view.isPending).toBe(false);
    expect(requests).toHaveLength(1);
  }),
);

it.effect("uses measured tall rows rather than prefetching from the initial size estimate", () =>
  Effect.gen(function* () {
    rowHeight = 400;
    yield* setupRuntime;
    yield* mountInbox();
    yield* finishPage(0, page);
    expect(boundary.list!.getState().contentLength).toBeGreaterThan(viewportHeight);
    expect(requests).toHaveLength(1);
  }),
);

it.effect("shows indicative categories, archives, pending and errors without hiding entries", () =>
  Effect.gen(function* () {
    yield* setupRuntime;
    yield* mountInbox();
    const qualification = {
      version: 1 as const,
      status: "qualified" as const,
      category: "no_action" as const,
      probabilities: {
        no_action: 0.8,
        information: 0.05,
        personal_action: 0.05,
        technical_action: 0.05,
        unsure: 0.05,
      },
      confidence: 0.9,
      model: "jev-1.14.0",
      qualifiedAt: "2026-11-08T12:00:00Z",
      usage: { input_tokens: 100, output_tokens: 10 },
    };
    const messages = pageFor(0, null).messages.map((entry, i) =>
      i === 0
        ? { ...entry, qualification }
        : i === 1
          ? {
              ...entry,
              qualificationAttempt: {
                status: "error" as const,
                error: "api" as const,
                token: "test",
                attempts: 1,
                nextAttemptAt: "2026-11-08T12:00:30Z",
              },
            }
          : entry,
    );
    yield* finishPage(0, { messages, nextCursor: null });
    expect(host.textContent).toContain("Sans action");
    expect(host.textContent).toContain("À réessayer");
    expect(host.textContent).toContain("À examiner");
    expect(host.querySelector('[title="Qualification Jev indicative"]')).not.toBeNull();
    expect(
      host.querySelector('[title="Qualification en erreur (api) · reprise en attente"]'),
    ).not.toBeNull();
    expect(host.querySelectorAll('img[alt="Gmail"]')).toHaveLength(5);
    expect(host.querySelectorAll("details")).toHaveLength(5);
    expect(host.querySelector('[aria-label="Contexte antérieur"]')).toBeNull();
    const details = host.querySelector("details")!;
    yield* Effect.promise(async () => {
      await act(() => {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
    });
    expect(host.querySelector('[aria-label="Contexte antérieur"]')).not.toBeNull();
  }),
);

it.effect("consults a subject and its original message/source through the real query session", () =>
  Effect.gen(function* () {
    yield* setupRuntime;
    yield* mountInbox();
    yield* Effect.promise(async () => {
      await act(() =>
        [...host.querySelectorAll("button")].find((b) => b.textContent === "Sujets")!.click(),
      );
    });
    expect(host.textContent).toContain("Incident Alpha");
    yield* Effect.promise(async () => {
      await act(() => {
        const subject = host.querySelector("details")!;
        subject.open = true;
        subject.dispatchEvent(new Event("toggle"));
      });
    });
    expect(host.textContent).toContain("Problème, logs et résolution.");
    expect(host.textContent).toContain("Subject 0");
    yield* Effect.promise(async () => {
      await act(() => {
        const entry = host.querySelectorAll("details")[1]!;
        entry.open = true;
        entry.dispatchEvent(new Event("toggle"));
      });
    });
    expect(host.textContent).toContain("Hello");
    expect(host.querySelector('a[href="https://example.com"]')).not.toBeNull();
    const first = host.querySelectorAll("details")[1]!;
    const second = host.querySelectorAll("details")[2]!;
    yield* Effect.promise(async () => {
      await act(() => {
        second.open = true;
        second.dispatchEvent(new Event("toggle"));
      });
      await act(() => {
        first.dispatchEvent(new Event("toggle"));
      });
    });
    expect(second.open).toBe(true);
    expect(second.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(requests).toHaveLength(1);
  }),
);

const subjectPageFor = (
  start: number,
  nextCursor: number | null,
): typeof InboxSubjectsPage.Type => ({
  subjects: Array.from({ length: 5 }, (_, i) => ({
    sequence: start + i + 1,
    id: `topic-${start + i}`,
    title: `Sujet ${start + i}`,
    summary: `Résumé ${start + i}`,
    createdAt: "2026-11-09",
    entries: 2,
  })),
  nextCursor,
});
const mountSubjects = () =>
  Effect.gen(function* () {
    controlledSubjects = true;
    yield* setupRuntime;
    yield* mountInbox();
    yield* Effect.promise(async () => {
      await act(() =>
        [...host.querySelectorAll("button")].find((b) => b.textContent === "Sujets")!.click(),
      );
    });
  });
const finishSubjects = (index: number, page: typeof InboxSubjectsPage.Type) =>
  Effect.promise(async () => {
    await act(() => subjectRequests[index]!.finish(page));
    await layoutFrames();
  });
const scrollBottom = () =>
  Effect.promise(async () => {
    const node = boundary.list!.getScrollableNode() as HTMLElement;
    await act(() => {
      node.scrollTop = Math.max(
        0,
        boundary.list!.getState().contentLength - boundary.list!.getState().scrollLength,
      );
      node.dispatchEvent(new Event("scroll"));
    });
    await act(() => node.dispatchEvent(new Event("scrollend")));
    await layoutFrames();
  });

it.effect.each(["messages", "subjects"] as const)(
  "continues %s past ten compact rows while the end callback remains inside its threshold",
  (kind) =>
    Effect.gen(function* () {
      viewportHeight = 636;
      rowHeight = 65;
      footerHeight = 0;
      if (kind === "subjects") yield* mountSubjects();
      else {
        yield* setupRuntime;
        yield* mountInbox();
      }
      const pending = kind === "subjects" ? subjectRequests : requests;
      expect(pending).toHaveLength(1);
      if (kind === "subjects") yield* finishSubjects(0, subjectPageFor(0, 5));
      else yield* finishPage(0, pageFor(0, 5));
      expect(pending).toHaveLength(2);
      expect(pending[1]!.input).toEqual({ after: 5, order: "desc", processed: false, limit: 5 });
      if (kind === "subjects") yield* finishSubjects(1, subjectPageFor(5, 10));
      else yield* finishPage(1, pageFor(5, 10));
      // Ten 65px rows overflow the 636px viewport by only 14px, still inside its 318px threshold.
      expect(boundary.list!.getState().contentLength).toBe(650);
      expect(pending).toHaveLength(3);
      expect(pending[2]!.input).toEqual({ after: 10, order: "desc", processed: false, limit: 5 });
      yield* Effect.promise(layoutFrames);
      expect(pending).toHaveLength(3);
      if (kind === "subjects") yield* finishSubjects(2, subjectPageFor(10, 15));
      else yield* finishPage(2, pageFor(10, 15));
      expect(pending).toHaveLength(3);
      yield* scrollBottom();
      expect(pending).toHaveLength(4);
      if (kind === "subjects") yield* finishSubjects(3, subjectPageFor(15, null));
      else yield* finishPage(3, pageFor(15, null));
      yield* scrollBottom();
      expect(pending).toHaveLength(4);
    }),
);

it.effect(
  "keeps subjects on error, retries explicitly, deduplicates, stops without progress and refreshes from the start",
  () =>
    Effect.gen(function* () {
      yield* mountSubjects();
      yield* finishSubjects(0, subjectPageFor(0, 5));
      expect(subjectRequests).toHaveLength(2);
      yield* Effect.promise(async () => {
        await act(() => subjectRequests[1]!.fail());
        await layoutFrames();
      });
      expect(host.textContent).toContain("Sujet 0");
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      yield* scrollBottom();
      expect(subjectRequests).toHaveLength(2);
      yield* Effect.promise(async () => {
        await act(() =>
          [...host.querySelectorAll("button")].find((b) => b.textContent === "Réessayer")!.click(),
        );
      });
      expect(subjectRequests[2]!.input).toEqual({
        after: 5,
        order: "desc",
        processed: false,
        limit: 5,
      });
      yield* finishSubjects(2, subjectPageFor(0, 10));
      expect(boundary.list!.getState().data).toHaveLength(5);
      expect(subjectRequests).toHaveLength(3);
      yield* scrollBottom();
      expect(subjectRequests).toHaveLength(3);
      yield* Effect.promise(async () => {
        await act(() =>
          [...host.querySelectorAll("button")].find((b) => b.textContent === "Actualiser")!.click(),
        );
      });
      expect(subjectRequests[3]!.input).toEqual({ order: "desc", processed: false, limit: 5 });
      yield* finishSubjects(3, subjectPageFor(0, null));
      yield* scrollBottom();
      expect(subjectRequests).toHaveLength(4);
    }),
);

it.effect(
  "virtualizes subjects and preserves the open subject after it leaves and reenters the viewport",
  () =>
    Effect.gen(function* () {
      viewportHeight = 300;
      yield* mountSubjects();
      yield* finishSubjects(0, subjectPageFor(0, 5));
      yield* Effect.promise(async () => {
        await act(() => {
          const row = host.querySelector("details")!;
          row.open = true;
          row.dispatchEvent(new Event("toggle"));
        });
      });
      expect(host.textContent).toContain("Résumé 0");
      for (let i = 1; i < 8; i++) {
        yield* scrollBottom();
        yield* finishSubjects(i, subjectPageFor(i * 5, i === 7 ? null : (i + 1) * 5));
      }
      expect(boundary.list!.getState().data).toHaveLength(40);
      expect(host.querySelectorAll("details").length).toBeLessThan(30);
      yield* Effect.promise(async () => {
        const node = boundary.list!.getScrollableNode() as HTMLElement;
        await act(() => {
          node.scrollTop = 0;
          node.dispatchEvent(new Event("scroll"));
        });
        await act(() => node.dispatchEvent(new Event("scrollend")));
        await layoutFrames();
      });
      expect(host.textContent).toContain("Résumé 0");
      expect(
        [...host.querySelectorAll("details")].find((row) =>
          row.querySelector("summary")?.textContent?.includes("Sujet 0Résumé 0"),
        )?.open,
      ).toBe(true);
    }),
);

async function openSubject() {
  await act(() => {
    host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click();
  });
  await act(() => {
    const card = host.querySelector("details")!;
    card.open = true;
    card.dispatchEvent(new Event("toggle"));
  });
}
async function clickText(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  )!;
  expect(button.disabled).toBe(false);
  await act(() => button.click());
}

it.effect.each(["messages", "subjects"] as const)(
  "starts fresh %s pages when toggling Traités and ignores a late response from the previous filter",
  (kind) =>
    Effect.gen(function* () {
      viewportHeight = 300;
      if (kind === "subjects") yield* mountSubjects();
      else {
        yield* setupRuntime;
        yield* mountInbox();
      }
      const pending = kind === "subjects" ? subjectRequests : requests;
      if (kind === "subjects") yield* finishSubjects(0, subjectPageFor(0, 5));
      else yield* finishPage(0, pageFor(0, 5));
      yield* scrollBottom();
      expect(pending).toHaveLength(2);
      yield* Effect.promise(() => clickText("Traités"));
      expect(pending).toHaveLength(3);
      expect(pending[2]!.input).toEqual({ order: "desc", processed: true, limit: 5 });
      if (kind === "subjects") {
        yield* finishSubjects(1, subjectPageFor(5, null));
        const page = subjectPageFor(100, null);
        yield* finishSubjects(2, {
          ...page,
          subjects: page.subjects.map((s) => ({ ...s, ignored: true })),
        });
      } else {
        yield* finishPage(1, pageFor(5, null));
        yield* finishPage(2, pageFor(100, null));
      }
      expect(host.textContent).not.toContain(kind === "subjects" ? "Sujet 5" : "Subject 5");
      expect(host.textContent).toContain(kind === "subjects" ? "Sujet 100" : "Subject 100");
      expect(boundary.list!.getState().data).toHaveLength(5);
      yield* Effect.promise(() => clickText("Traités"));
      expect(pending).toHaveLength(4);
      expect(pending[3]!.input).toEqual({ order: "desc", processed: false, limit: 5 });
    }),
);
it.effect(
  "opens deterministic human creation without a request and submits once until acknowledged",
  () =>
    Effect.gen(function* () {
      yield* setupRuntime;
      yield* mountInbox();
      yield* Effect.promise(async () => {
        await openSubject();
        await clickText("Créer une tâche");
        expect(actions).toHaveLength(0);
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("Incident Alpha");
        expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
          "Problème, logs et résolution.",
        );
        await act(() => {
          const form = host.querySelector("form")!;
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        });
        expect(actions).toHaveLength(1);
        expect(actions[0]!.input).toMatchObject({
          kind: "create",
          title: "Incident Alpha",
          description: "Problème, logs et résolution.",
          projectId: null,
        });
        await act(() =>
          actions[0]!.finish({
            subjectId: "incident",
            actionVersion: 1,
            ignored: false,
            taskId: "created",
          }),
        );
        expect(host.textContent).toContain("Aucun sujet à traiter.");
        expect(host.querySelector("form")).toBeNull();
        await clickText("Traités");
        await openSubject();
        expect(host.textContent).toContain("Ouvrir la tâche liée");
      });
    }),
);
it.effect(
  "reviews a task context before completing only its notes and keeps creation available",
  () =>
    Effect.gen(function* () {
      subjectContext = {
        context: { kind: "task", id: "existing", projectId: null },
        contextLabel: existingTask.title,
      };
      yield* setupRuntime;
      yield* mountInbox();
      yield* Effect.promise(async () => {
        await openSubject();
        expect(host.textContent).toContain("Créer une tâche");
        await clickText("Compléter la tâche");
        expect(actions).toHaveLength(0);
        expect(host.textContent).toContain(existingTask.notes);
        expect(host.querySelector("input")).toBeNull();
        expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
          "Problème, logs et résolution.",
        );
        await act(() =>
          host
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(actions).toHaveLength(1);
        expect(actions[0]!.input).toMatchObject({
          kind: "complete",
          taskId: "existing",
          taskVersion: 3,
          description: "Problème, logs et résolution.",
        });
        expect(actions[0]!.input).not.toHaveProperty("title");
        expect(actions[0]!.input).not.toHaveProperty("projectId");
        await act(() =>
          actions[0]!.finish({
            subjectId: "incident",
            actionVersion: 1,
            ignored: false,
            taskId: "existing",
            taskLinkKind: "completed",
          }),
        );
        expect(host.textContent).toContain("Aucun sujet à traiter.");
        await clickText("Traités");
        await openSubject();
        expect(host.textContent).toContain("Compléter la tâche");
        expect(host.textContent).not.toContain("Mettre à jour la tâche");
      });
    }),
);

it.effect("prefills a chantier context for creation and lets the human choose no chantier", () =>
  Effect.gen(function* () {
    subjectContext = {
      context: { kind: "chantier", id: "c", projectId: ProjectId.make("p") },
      contextLabel: "Chantier Alpha",
    };
    yield* setupRuntime;
    yield* mountInbox();
    yield* Effect.promise(async () => {
      await openSubject();
      await clickText("Créer une tâche");
      const chantier = host.querySelectorAll<HTMLSelectElement>("select")[1]!;
      expect(chantier.value).toBe("c");
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      expect(host.textContent).toContain("Ce chantier n’est plus disponible");
      await act(() => {
        chantier.value = "";
        chantier.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
      await act(() =>
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(actions[0]!.input).toMatchObject({
        kind: "create",
        projectId: "p",
        chantierId: null,
      });
    });
  }),
);

it.effect(
  "targets the already linked task and displays its retained notes before reviewing an addition",
  () =>
    Effect.gen(function* () {
      subjectTask = existingTask;
      yield* setupRuntime;
      yield* mountInbox();
      yield* Effect.promise(async () => {
        await openSubject();
        await clickText("Mettre à jour la tâche");
        const select = host.querySelector<HTMLSelectElement>("select")!;
        expect(select.value).toBe("");
        expect(select.disabled).toBe(true);
        expect(actions).toHaveLength(0);
        expect(host.textContent).toContain(existingTask.notes);
        expect(host.querySelector<HTMLInputElement>("input")!.value).toBe(existingTask.title);
        await act(() =>
          host
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(actions[0]!.input).toMatchObject({
          kind: "update",
          taskId: "existing",
          taskVersion: 3,
          title: existingTask.title,
          description: "",
          projectId: null,
        });
      });
    }),
);

it.effect(
  "keeps definitively closed subjects readable without any reopen or task mutation action",
  () =>
    Effect.gen(function* () {
      subjectTask = { ...existingTask, status: "done" };
      subjectDecision = {
        subjectId: "incident",
        actionVersion: 2,
        ignored: false,
        taskId: existingTask.id,
        processed: true,
        closedAt: "2026-11-10T09:00:00Z",
      };
      yield* setupRuntime;
      yield* mountInbox();
      yield* Effect.promise(async () => {
        await clickText("Traités");
        await openSubject();
        expect(host.textContent).toContain("Sujet définitivement terminé.");
        expect(host.textContent).toContain("Ouvrir la tâche liée");
        const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
        for (const name of [
          "Créer une tâche",
          "Mettre à jour la tâche",
          "Ignorer ce sujet",
          "Rétablir ce sujet",
        ])
          expect(buttons).not.toContain(name);
        expect(actions).toHaveLength(0);
      });
    }),
);
it.effect(
  "moves ignored subjects to the processed filter and restores them to the default view",
  () =>
    Effect.gen(function* () {
      yield* setupRuntime;
      yield* mountInbox();
      yield* Effect.promise(async () => {
        await openSubject();
        await clickText("Ignorer ce sujet");
        expect(actions[0]!.input).toMatchObject({
          kind: "ignore",
          ignored: true,
          expectedVersion: 0,
        });
        await act(() =>
          actions[0]!.finish({
            subjectId: "incident",
            actionVersion: 1,
            ignored: true,
            taskId: null,
          }),
        );
        expect(host.textContent).toContain("Aucun sujet à traiter.");
        await clickText("Traités");
        await openSubject();
        expect(host.textContent).toContain("Ignoré");
        expect(host.textContent).toContain("Subject 0");
        await clickText("Rétablir ce sujet");
        expect(actions[1]!.input).toMatchObject({
          kind: "ignore",
          ignored: false,
          expectedVersion: 1,
        });
        await act(() =>
          actions[1]!.finish({
            subjectId: "incident",
            actionVersion: 2,
            ignored: false,
            taskId: null,
          }),
        );
        expect(host.textContent).toContain("Aucun sujet traité.");
        await clickText("Traités");
        expect(host.textContent).toContain("Incident Alpha");
      });
    }),
);
