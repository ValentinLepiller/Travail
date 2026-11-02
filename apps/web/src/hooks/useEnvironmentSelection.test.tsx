import { EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useEnvironmentSelection } from "./useEnvironmentSelection";

const state = vi.hoisted(() => ({
  isReady: true,
  primaryId: null as EnvironmentId | null,
  environments: [] as Array<{
    environmentId: EnvironmentId;
    connection: { phase: string };
  }>,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ isReady: state.isReady, environments: state.environments }),
  usePrimaryEnvironmentId: () => state.primaryId,
}));

const localId = EnvironmentId.make("travail-harness");
const remoteId = EnvironmentId.make("remote");
let selection: ReturnType<typeof useEnvironmentSelection>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useEnvironmentSelection();
  useLayoutEffect(() => {
    selection = value;
  });
  return null;
}
function render() {
  act(() => renderer.update(<Probe />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.primaryId = null;
  state.isReady = true;
  state.environments = [{ environmentId: localId, connection: { phase: "connected" } }];
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("uses Travail's registered connection without a primary backend", () => {
  expect(selection.environmentId).toBe(localId);
});
it("chooses a connected server when other saved machines are offline", () => {
  state.environments.unshift({ environmentId: remoteId, connection: { phase: "disconnected" } });
  render();
  expect(selection.environmentId).toBe(localId);
});
it("preserves the primary backend as the default when it exists", () => {
  state.primaryId = remoteId;
  state.environments.push({ environmentId: remoteId, connection: { phase: "connected" } });
  render();
  expect(selection.environmentId).toBe(remoteId);
});
it("keeps a user's chosen server during disconnection and falls back when removed", () => {
  state.environments.push({ environmentId: remoteId, connection: { phase: "connected" } });
  act(() => selection.setEnvironmentId(remoteId));
  expect(selection.environmentId).toBe(remoteId);
  state.environments[1] = { environmentId: remoteId, connection: { phase: "disconnected" } };
  render();
  expect(selection.environmentId).toBe(remoteId);
  state.environments.pop();
  render();
  expect(selection.environmentId).toBe(localId);
});
it("selects the connection when the catalog finishes loading", () => {
  state.isReady = false;
  state.environments = [];
  render();
  expect(selection.environmentId).toBeNull();
  expect(selection.isReady).toBe(false);
  state.isReady = true;
  state.environments = [{ environmentId: localId, connection: { phase: "connected" } }];
  render();
  expect(selection.environmentId).toBe(localId);
});
it("keeps a reconnecting server selectable without claiming none is registered", () => {
  state.environments = [{ environmentId: localId, connection: { phase: "connecting" } }];
  render();
  expect(selection.environmentId).toBe(localId);
});
