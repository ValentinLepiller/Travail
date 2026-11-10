import { expect, it } from "@effect/vitest";
import { collectContext, readSourceContext } from "./readSourceContext.ts";

const source = {
  kind: "gmail" as const,
  message: {
    accountEmail: "me@example.com",
    id: "target",
    threadId: "thread",
    receivedAt: "1793278001.000000",
    sender: "Client",
    subject: "Test",
    text: "Target",
  },
};
it("requires a context response before returning a collected message", async () => {
  const result = await collectContext(source, async (operation, args) => {
    expect(operation).toBe("gmail.thread");
    expect(args).toEqual({ thread_id: "thread", max_messages: 100 });
    return {
      id: "thread",
      messages: [
        {
          id: "target",
          thread_id: "thread",
          internal_date: "1793278001000",
          payload: { headers: [], body: { data: "" } },
        },
      ],
    };
  });
  expect(result).toMatchObject({ version: 1, status: "ready", messages: [] });
});
it("fails collection on connector failure instead of returning a misleading empty context", async () => {
  const call = async () => {
    throw new Error("offline");
  };
  expect(await readSourceContext(source, call)).toMatchObject({
    status: "unavailable",
    reason: "source",
  });
  await expect(collectContext(source, call)).rejects.toThrow("Context fetch failed");
});
