import type { EnvironmentId } from "@t3tools/contracts";
import { useStore } from "zustand";
import { workPageEnvironmentState } from "../state/workPageState";
import { useEnvironmentSelection } from "./useEnvironmentSelection";

export function useWorkPageEnvironmentSelection(view: "requests" | "tasks") {
  const selection = useEnvironmentSelection();
  const page = workPageEnvironmentState(view);
  const selectedId = useStore(page, (state) => state.environmentId);
  return {
    ...selection,
    environmentId:
      selection.environments.find((entry) => entry.environmentId === selectedId)?.environmentId ??
      selection.environmentId,
    setEnvironmentId: (environmentId: EnvironmentId | null) => page.setState({ environmentId }),
  };
}
