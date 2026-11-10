import { EnvironmentId, WorkTask, WorkTaskSaveInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { createStore, type StoreApi } from "zustand/vanilla";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

// Keep the in-memory state even when browser storage is unavailable or full.
function localPageState<T, E>(name: string, schema: Schema.Codec<T, E>, initial: T) {
  const stores = new Map<string, StoreApi<T>>();
  return (environmentId: string) => {
    const existing = stores.get(environmentId);
    if (existing) return existing;
    const key = `travail:${name}:v1:${environmentId}`;
    let saved = initial;
    try {
      saved = getLocalStorageItem(key, schema) ?? initial;
    } catch {
      // A malformed or inaccessible saved value must not prevent opening the page.
    }
    const store = createStore<T>(() => saved);
    store.subscribe((state) => {
      try {
        setLocalStorageItem(key, state, schema);
      } catch {
        // Navigation still restores this session's state from the store.
      }
    });
    stores.set(environmentId, store);
    return store;
  };
}

const RequestDraft = Schema.Struct({ version: Schema.Number, text: Schema.String });
const RequestPageState = Schema.Struct({
  discussion: Schema.optionalKey(Schema.NullOr(Schema.Literals(["source", "temporary"]))),
  temporaryDrafts: Schema.optionalKey(Schema.Record(Schema.String, RequestDraft)),
  archive: Schema.Boolean,
  selected: Schema.NullOr(Schema.String),
  drafts: Schema.Record(Schema.String, RequestDraft),
});
export const requestPageState = localPageState("request-page", RequestPageState, {
  archive: false,
  selected: null,
  drafts: {},
});

const TaskFilter = Schema.Literals([
  "all",
  "ready",
  "mine",
  "agents",
  "review",
  "done",
  "rejected",
  "merged",
]);
const WorkTaskDraft = Schema.Struct({
  ...WorkTaskSaveInput.fields,
  title: Schema.String,
  notes: Schema.String,
  status: WorkTask.fields.status,
  pendingImages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        error: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type WorkTaskDraft = typeof WorkTaskDraft.Type;

const TaskPageState = Schema.Struct({
  filter: Schema.Union([TaskFilter, Schema.Literals(["unqualified", "todo"])]).pipe(
    Schema.decodeTo(
      TaskFilter,
      SchemaTransformation.transform({
        decode: (filter) => (filter === "unqualified" || filter === "todo" ? "ready" : filter),
        encode: (filter) => filter,
      }),
    ),
  ),
  search: Schema.String,
  projectFilter: Schema.String,
  // Incomplete titles are valid local drafts, but remain invalid save inputs.
  editing: Schema.NullOr(WorkTaskDraft),
});
export const taskPageState = localPageState("task-page", TaskPageState, {
  filter: "all",
  search: "",
  projectFilter: "",
  editing: null,
});

export const workPageEnvironmentState = localPageState(
  "work-page-environment",
  Schema.Struct({ environmentId: Schema.NullOr(EnvironmentId) }),
  { environmentId: null },
);
