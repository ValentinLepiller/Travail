// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  AgentRequestError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type AgentRequest,
  type AgentRequestRespond,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

type RpcSession =
  EnvironmentSupervisor.EnvironmentSupervisor["Service"]["session"] extends SubscriptionRef.SubscriptionRef<
    Option.Option<infer Session>
  >
    ? Session
    : never;
const boundary = vi.hoisted(() => ({
  service: undefined as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
}));
vi.mock("../../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity"),
    Layer = await import("effect/Layer");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  const service = new Proxy({} as EnvironmentRegistry.EnvironmentRegistry["Service"], {
    get: (_target, key) =>
      boundary.service[key as keyof EnvironmentRegistry.EnvironmentRegistry["Service"]],
  });
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, service),
    ),
  };
});
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", async () => {
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
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useProject: () => null,
  useThreadShell: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/chef">{children}</a>,
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
import { RequestCard } from "../agentRequests/AgentRequestsPage";
import { requestPageState } from "../../state/workPageState";

const environmentId = EnvironmentId.make("chef-consent-test");
const phrase = "Ignorer les invitations événementielles de Weyou.";
const original: AgentRequest = {
  id: "chef:request",
  threadId: ThreadId.make("chef-dossier:alpha"),
  version: 2,
  context:
    "Dans Travail, une invitation de Weyou attend une décision. Le Chef propose de mettre ce sujet de côté.",
  question: "Ignorer ce sujet ?",
  details: "Invitation à un événement.",
  kind: "approval",
  action: null,
  status: "pending",
  response: "",
  history: [],
  actionStatus: "idle",
  delivery: "none",
  createdAt: "",
  updatedAt: "",
  chef: {
    decisionId: "chef:request",
    dossierIds: ["alpha"],
    memory: {
      kind: "rule",
      text: phrase,
      scope: { kind: "global", id: null },
      topic: "Invitations Weyou",
      action: "ignore",
    },
  },
};
let registry: AtomRegistry.AtomRegistry, root: Root, host: HTMLDivElement;
let calls: AgentRequestRespond[], conflict: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls = [];
  conflict = false;
  requestPageState(environmentId).setState({ drafts: {}, temporaryDrafts: {} });
});
afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  host.remove();
  vi.unstubAllGlobals();
});
const setup = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
    desired: true,
    network: "online",
    attempt: 1,
    generation: 1,
  });
  const rpc = {
    initialConfig: Effect.succeed({
      environment: { capabilities: { performanceStatistics: false } },
    }),
    client: {
      [WS_METHODS.agentRequestsRespond]: (input: AgentRequestRespond) =>
        Effect.suspend(() => {
          calls.push(input);
          return conflict
            ? Effect.fail(new AgentRequestError({ reason: "conflict" }))
            : Effect.succeed({ ...original, status: "accepted" as const });
        }),
    },
  } as unknown as RpcSession;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    state,
    session: yield* SubscriptionRef.make(Option.some(rpc)),
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
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  boundary.service = {
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
});
const render = (request = original) =>
  Effect.promise(async () => {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <RequestCard request={request} environmentId={environmentId} inline />
        </RegistryContext.Provider>,
      ),
    );
  });
const click = (label: string) =>
  Effect.promise(async () => {
    await act(async () => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      expect(button, label).toBeDefined();
      expect(button!.disabled).toBe(false);
      button!.click();
    });
  });

it.effect(
  "shows the exact phrase before a one-off Action and never requests memorization implicitly",
  () =>
    Effect.gen(function* () {
      yield* setup;
      yield* render();
      expect(host.querySelector("blockquote")?.textContent).toBe(phrase);
      expect(calls).toHaveLength(0);
      yield* click("Action");
      expect(calls).toEqual([
        { id: original.id, expectedVersion: 2, decision: "accept", text: "", remember: false },
      ]);
    }),
);
it.effect("only the explicit Action + mémoriser la règle button requests memorization", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* render();
    yield* click("Action + mémoriser la règle");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: original.id, expectedVersion: 2, remember: true });
  }),
);
it.effect(
  "a conflicting approval is not retried automatically and the revised phrase must be shown again",
  () =>
    Effect.gen(function* () {
      yield* setup;
      yield* render();
      conflict = true;
      yield* click("Action + mémoriser la règle");
      expect(calls).toHaveLength(1);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      const updated = {
        ...original,
        version: 3,
        chef: {
          ...original.chef!,
          memory: {
            ...original.chef!.memory!,
            text: "Ignorer uniquement les rappels de ces invitations.",
          },
        },
      };
      yield* render(updated);
      expect(host.querySelector("blockquote")?.textContent).toBe(updated.chef.memory.text);
      expect(calls).toHaveLength(1);
    }),
);
