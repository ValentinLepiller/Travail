import { expect, it } from "vite-plus/test";
import { inspectSource, type InspectionCall } from "./inspectSource.ts";
const gmail = {
  kind: "gmail" as const,
  message: {
    accountEmail: "me@example.com",
    id: "old",
    threadId: "thread",
    receivedAt: "1793278000.000000",
    sender: "Client",
    subject: "Repli",
    text: "Je regarde ça",
  },
};
const mail = (id: string, text: string) => ({
  id,
  thread_id: "thread",
  internal_date: "1793278002000",
  payload: { headers: [], mime_type: "text/plain", body: { content: text } },
});
it("includes a later completion reply when checking an old Inbox message", async () => {
  const result = await inspectSource(gmail, async (op, args) => {
    expect(op).toBe("gmail.thread");
    expect(args).toEqual({ thread_id: "thread", max_messages: 100 });
    return {
      id: "thread",
      messages: [mail("old", "Je regarde ça"), mail("new", "Corrigé et livré")],
    };
  });
  expect(result.status).toBe("ready");
  expect(result.text).toContain("Corrigé et livré");
});
it("reads Gmail search hits, including sent replies, without changing labels or marking read", async () => {
  const calls: string[] = [];
  const result = await inspectSource(
    gmail,
    async (op, args) => {
      calls.push(op);
      if (op === "gmail.search") {
        expect(args).toEqual({ query: '"repli"', max_results: 3 });
        return { message_ids: ["hit"], next_page_token: "next" };
      }
      expect(args).toEqual({ message_id: "hit", format: "full" });
      return mail("hit", "C’est déjà traité");
    },
    '"repli"',
  );
  expect(calls).toEqual(["gmail.search", "gmail.read"]);
  expect(result.status).toBe("partial");
  expect(result.text).toContain("déjà traité");
});
it("reads the current Slack thread and channel without the collection's before-target cutoff", async () => {
  const source = {
    kind: "slack" as const,
    message: {
      workspaceId: "T1",
      channelId: "C1",
      channelName: "test",
      authorId: "U1",
      ts: "1793278000.000000",
      threadTs: "1793278000.000000",
      text: "Je regarde",
    },
  };
  const call: InspectionCall = async (op, args) => {
    expect(args.latest).toBeUndefined();
    if (op === "slack.read")
      return {
        messages:
          "=== THREAD PARENT MESSAGE ===\nFrom: Client (U1)\nTime: now\nMessage TS: 1793278000.000000\nJe regarde\n=== THREAD REPLIES (1 total) ===\n--- Reply 1 of 1 ---\nFrom: Valentin (U2)\nTime: later\nMessage TS: 1793279000.000000\nC’est livré",
        pagination_info: "There are no more messages in this thread.",
      };
    expect(op).toBe("slack.readChannel");
    return {
      messages:
        "Channel: test (C1)\n\n=== Message from Valentin (U2) at later ===\nMessage TS: 1793279000.000000\nC’est livré\n",
      pagination_info: "There are no more messages",
    };
  };
  const r = await inspectSource(source, call);
  expect(r.text).toContain("livré");
  expect(r.status).toBe("ready");
});
it("propagates connector failure and marks bounded excerpts as incomplete", async () => {
  await expect(
    inspectSource(gmail, async () => {
      throw Error("offline");
    }),
  ).rejects.toThrow("offline");
  const r = await inspectSource(gmail, async () => ({
    id: "thread",
    messages: [mail("old", "x".repeat(50000))],
  }));
  expect(r.status).toBe("partial");
  expect(r.truncated).toBe(true);
  expect(r.text.length).toBeLessThanOrEqual(12000);
});
