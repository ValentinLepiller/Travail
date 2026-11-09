import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type InboxPage, type InboxMessage } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Request = {
  environmentId: EnvironmentId;
  input: { after?: number; limit: number };
  succeed: (page: typeof InboxPage.Type) => void;
  fail: () => void;
};
const boundary = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  class QueryError extends Schema.TaggedError<QueryError>()("TestInboxQueryError", {
    message: Schema.String,
  }) {}
  return {
    createEnvironmentRpcQueryAtomFamily: () => {
      const family = Atom.family((key: string) =>
        Atom.make(
          Effect.callback<typeof InboxPage.Type, QueryError>((resume) => {
            const target = JSON.parse(key) as Pick<Request, "environmentId" | "input">;
            boundary.requests.push({
              ...target,
              succeed: (page) => resume(Effect.succeed(page)),
              fail: () => resume(Effect.fail(new QueryError({ message: "Page indisponible" }))),
            });
          }),
        ).pipe(Atom.setIdleTTL(0)),
      );
      return (target: Pick<Request, "environmentId" | "input">) => family(JSON.stringify(target));
    },
  };
});
import { useInboxMessages } from "./inbox";

const primary = EnvironmentId.make("primary"),
  remote = EnvironmentId.make("remote");
const message = (id: string): InboxMessage => ({
  id,
  collectedAt: "2026-11-08T13:55:26.397Z",
  url: "https://example.com/message",
  source: {
    kind: "gmail",
    message: {
      id,
      accountEmail: "me@example.com",
      threadId: id,
      receivedAt: "1793975400.000001",
      sender: "Client",
      subject: id,
      text: id,
    },
  },
});
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let view: ReturnType<typeof useInboxMessages>;
function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  const value = useInboxMessages(environmentId);
  useEffect(() => {
    view = value;
  }, [value]);
  return null;
}
function render(environmentId = primary, revision = 0) {
  return (
    <RegistryContext.Provider value={registry}>
      <Probe key={`${environmentId}:${revision}`} environmentId={environmentId} />
    </RegistryContext.Provider>
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.requests = [];
  registry = AtomRegistry.make();
  await act(() => {
    renderer = create(render());
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

it("loads five at a time using returned cursors, deduplicates and stops at the last page", async () => {
  expect(view.isPending).toBe(true);
  expect(boundary.requests[0]?.input).toEqual({ limit: 5 });
  await act(() =>
    boundary.requests[0]!.succeed({ messages: [message("a"), message("b")], nextCursor: 47 }),
  );
  await act(() => {
    view.loadNext();
    view.loadNext();
    view.loadNext();
  });
  expect(boundary.requests).toHaveLength(2);
  expect(boundary.requests[1]?.input).toEqual({ after: 47, limit: 5 });
  expect(view.messages.map((x) => x.id)).toEqual(["a", "b"]);
  await act(() =>
    boundary.requests[1]!.succeed({ messages: [message("b"), message("c")], nextCursor: null }),
  );
  expect(view.messages.map((x) => x.id)).toEqual(["a", "b", "c"]);
  await act(() => view.loadNext());
  expect(boundary.requests).toHaveLength(2);
  expect(view.isPending).toBe(false);
});
it("keeps loaded messages after failure and only retries on an explicit action", async () => {
  await act(() => boundary.requests[0]!.succeed({ messages: [message("a")], nextCursor: 91 }));
  await act(() => view.loadNext());
  await act(() => boundary.requests[1]!.fail());
  expect(view.error).toBe("Page indisponible");
  expect(view.messages.map((x) => x.id)).toEqual(["a"]);
  await act(() => {
    view.loadNext();
    view.loadNext();
  });
  expect(boundary.requests).toHaveLength(2);
  await act(() => view.retry());
  expect(boundary.requests[2]?.input).toEqual({ after: 91, limit: 5 });
  await act(() => boundary.requests[2]!.succeed({ messages: [message("b")], nextCursor: null }));
  expect(view.messages.map((x) => x.id)).toEqual(["a", "b"]);
  expect(view.error).toBeNull();
});
it("handles first-page failure, retry and an empty inbox", async () => {
  await act(() => boundary.requests[0]!.fail());
  expect(view.messages).toEqual([]);
  expect(view.error).toBe("Page indisponible");
  await act(() => view.loadNext());
  expect(boundary.requests).toHaveLength(1);
  await act(() => view.retry());
  expect(boundary.requests[1]?.input).toEqual({ limit: 5 });
  await act(() => boundary.requests[1]!.succeed({ messages: [], nextCursor: null }));
  expect(view.messages).toEqual([]);
  expect(view.isPending).toBe(false);
  expect(view.error).toBeNull();
});
it.each(["refresh", "machine"] as const)(
  "discards old pages and late responses on %s",
  async (change) => {
    await act(() => boundary.requests[0]!.succeed({ messages: [message("old")], nextCursor: 71 }));
    await act(() => view.loadNext());
    const old = boundary.requests[1]!;
    await act(() =>
      renderer.update(
        render(change === "machine" ? remote : primary, change === "refresh" ? 1 : 0),
      ),
    );
    expect(view.messages).toEqual([]);
    const fresh = boundary.requests[2]!;
    expect(fresh.input).toEqual({ limit: 5 });
    expect(fresh.environmentId).toBe(change === "machine" ? remote : primary);
    await act(() => old.succeed({ messages: [message("late")], nextCursor: 999 }));
    expect(view.messages).toEqual([]);
    await act(() => fresh.succeed({ messages: [message("fresh")], nextCursor: null }));
    expect(view.messages.map((x) => x.id)).toEqual(["fresh"]);
  },
);
