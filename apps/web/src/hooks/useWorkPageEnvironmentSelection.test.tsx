import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createMemoryStorage } from "../lib/storage";
import { workPageEnvironmentState } from "../state/workPageState";
import { useWorkPageEnvironmentSelection } from "./useWorkPageEnvironmentSelection";

const state = vi.hoisted(() => ({
  environments: [] as Array<{ environmentId: EnvironmentId; connection: { phase: string } }>,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: state.environments }),
  usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
}));
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
let selection: ReturnType<typeof useWorkPageEnvironmentSelection>;
let renderer: ReactTestRenderer;
function Probe({ view }: { view: "requests" | "tasks" }) {
  const value = useWorkPageEnvironmentSelection(view);
  useLayoutEffect(() => {
    selection = value;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { localStorage: createMemoryStorage() });
  state.environments = [local, remote].map((environmentId) => ({
    environmentId,
    connection: { phase: "connected" },
  }));
  for (const view of ["requests", "tasks"])
    workPageEnvironmentState(view).setState({ environmentId: null });
  act(() => {
    renderer = create(<Probe view="requests" />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("restores the selected machine after leaving and reopening Requests", () => {
  act(() => selection.setEnvironmentId(remote));
  act(() => renderer.unmount());
  act(() => {
    renderer = create(<Probe view="requests" />);
  });
  expect(selection.environmentId).toBe(remote);
});
it("keeps Tasks and Requests selections separate", () => {
  act(() => selection.setEnvironmentId(remote));
  act(() => renderer.update(<Probe view="tasks" />));
  expect(selection.environmentId).toBe(local);
  act(() => renderer.update(<Probe view="requests" />));
  expect(selection.environmentId).toBe(remote);
});
it("retains a disconnected selected machine and falls back when it is removed", () => {
  act(() => selection.setEnvironmentId(remote));
  state.environments[1] = { environmentId: remote, connection: { phase: "disconnected" } };
  act(() => renderer.update(<Probe view="requests" />));
  expect(selection.environmentId).toBe(remote);
  state.environments.pop();
  act(() => renderer.update(<Probe view="requests" />));
  expect(selection.environmentId).toBe(local);
});
