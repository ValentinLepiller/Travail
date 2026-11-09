import { expect, it } from "vite-plus/test";
import type { InboxSource } from "@t3tools/contracts";
import { selectContext } from "./contextMessages.ts";
import { parseSlackContext, parseGmailContext } from "./contextSourcePages.ts";
const slack = (n: number, text = `Message ${n}`): typeof InboxSource.Type => ({
  kind: "slack",
  message: {
    workspaceId: "TTEST",
    channelId: "CTEST",
    channelName: "projet",
    authorId: n === 2 ? "USELF" : "UCLIENT",
    ts: `179397540${n}.000001`,
    threadTs: "1793975400.000001",
    text,
  },
});
const gmail = (n: number): typeof InboxSource.Type => ({
  kind: "gmail",
  message: {
    accountEmail: "me@example.com",
    id: `mail${n}`,
    threadId: "thread",
    receivedAt: `179397540${n}.000001`,
    sender: n === 2 ? "Valentin" : "Client",
    subject: "Fil",
    text: `Message ${n}`,
  },
});

it.each([slack, gmail])(
  "keeps only strict predecessors, retains self authors and never includes the target",
  (factory) => {
    const target = factory(5),
      result = selectContext(target, [factory(6), factory(2), target, factory(0), factory(2)]);
    expect(result.status).toBe("ready");
    expect(result.messages).toEqual([factory(0), factory(2)]);
    expect(result.messages.some((x) => x.message.text === target.message.text)).toBe(false);
  },
);
it.each([slack, gmail])(
  "keeps initial and latest four previous messages when a thread is long",
  (factory) => {
    const result = selectContext(
      factory(9),
      Array.from({ length: 9 }, (_, i) => factory(i)),
    );
    expect(result.messages.map((x) => x.message.text)).toEqual(
      [0, 5, 6, 7, 8].map((n) => `Message ${n}`),
    );
    expect(result.truncated).toBe(true);
  },
);
it("uses latest five channel predecessors, not an arbitrary old channel message", () => {
  const target = slack(9);
  if (target.kind !== "slack") throw Error();
  const result = selectContext(
    { ...target, message: { ...target.message, threadTs: target.message.ts } },
    Array.from({ length: 9 }, (_, i) => slack(i)),
  );
  expect(result.messages.map((x) => x.message.text)).toEqual(
    [4, 5, 6, 7, 8].map((n) => `Message ${n}`),
  );
});
it("bounds total text to 10000 characters without hiding later authors and flags incomplete results", () => {
  const result = selectContext(
    slack(9),
    [0, 1, 2, 3, 4].map((n) => slack(n, "😀".repeat(8000))),
    true,
  );
  expect(result.messages).toHaveLength(5);
  expect(result.messages.reduce((n, x) => n + x.message.text.length, 0)).toBeLessThanOrEqual(10000);
  expect(
    result.messages.every(
      (x) => x.message.text.length > 0 && !/[\uD800-\uDBFF]$/.test(x.message.text),
    ),
  ).toBe(true);
  expect(result).toMatchObject({ status: "partial", truncated: true, reason: "limit" });
});
it("rejects context from another account, Gmail thread, Slack channel/workspace or Slack thread", () => {
  const g = gmail(5),
    s = slack(5);
  if (g.kind !== "gmail" || s.kind !== "slack") throw Error();
  for (const message of [
    { ...g.message, accountEmail: "other@example.com" },
    { ...g.message, threadId: "other" },
  ])
    expect(() => selectContext(g, [{ kind: "gmail", message }])).toThrow();
  for (const message of [
    { ...s.message, channelId: "COTHER" },
    { ...s.message, workspaceId: "TOTHER" },
    { ...s.message, threadTs: "1793975300.000001" },
  ])
    expect(() => selectContext(s, [{ kind: "slack", message }])).toThrow();
  expect(() => selectContext(s, [g])).toThrow();
});
it("distinguishes a complete empty channel response from unknown formats and wrong channels", () => {
  const target = slack(5);
  if (target.kind !== "slack") throw Error();
  expect(
    parseSlackContext(
      {
        messages: "Channel: projet (CTEST)\n\n",
        pagination_info: "There are no more messages available.\n",
      },
      target.message,
      false,
    ),
  ).toEqual({ sources: [], nextCursor: null });
  expect(() =>
    parseSlackContext(
      {
        messages: "Channel: projet (COTHER)\n\n",
        pagination_info: "There are no more messages available.\n",
      },
      target.message,
      false,
    ),
  ).toThrow();
  expect(() =>
    parseSlackContext({ messages: "", pagination_info: "Unknown response" }, target.message, false),
  ).toThrow();
});
it("parses native Slack thread parents/replies and preserves author IDs, names and timestamps", () => {
  const target = slack(5);
  if (target.kind !== "slack") throw Error();
  const page = parseSlackContext(
    {
      messages:
        "=== THREAD PARENT MESSAGE ===\nFrom: Client (UCLIENT)\nTime: date\nMessage TS: 1793975400.000001\nQuestion\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Valentin (USELF)\nTime: date\nMessage TS: 1793975402.000001\nRéponse\n",
      pagination_info: "There are no more messages in this thread.\n",
    },
    target.message,
    true,
  );
  expect(page.sources).toHaveLength(2);
  expect(page.sources[1]?.message).toMatchObject({
    authorId: "USELF",
    authorName: "Valentin",
    ts: "1793975402.000001",
    text: "Réponse",
  });
});
it("parses a native Slack channel including self replies and cursor without mixing the target", () => {
  const target = slack(5);
  if (target.kind !== "slack") throw Error();
  const page = parseSlackContext(
    {
      messages:
        "Channel: projet (CTEST)\n\n=== Message from Valentin (USELF) at date === \nMessage TS: 1793975402.000001\nRéponse\n\n",
      pagination_info:
        "There are more messages available. To view the next page, use cursor: `next`\n",
    },
    target.message,
    false,
  );
  expect(page.nextCursor).toBe("next");
  expect(page.sources[0]?.message).toMatchObject({
    authorName: "Valentin",
    threadTs: "1793975402.000001",
  });
});
it.each([true, false])(
  "preserves external Slack author identity in native layouts (thread=%s)",
  (threaded) => {
    const target = slack(5);
    if (target.kind !== "slack") throw Error();
    const author = "Partner <contact@example.com> (UEXTERNAL, external: Example Company)";
    const page = parseSlackContext(
      {
        messages: threaded
          ? `=== THREAD PARENT MESSAGE ===\nFrom: ${author}\nTime: date\nMessage TS: 1793975400.000001\nQuestion\n\nNo thread messsages\n`
          : `Channel: projet (CTEST)\n\n=== Message from ${author} at date === \nMessage TS: 1793975400.000001\nQuestion\n`,
        pagination_info: threaded
          ? "There are no more messages in this thread.\n"
          : "There are no more messages available.\n",
      },
      target.message,
      threaded,
    );
    expect(page.sources[0]?.message).toMatchObject({
      authorId: "UEXTERNAL",
      authorName: "Partner <contact@example.com>",
      ts: "1793975400.000001",
      text: "Question",
    });
    expect(selectContext(target, page.sources).messages).toHaveLength(1);
  },
);
it("rejects another Gmail thread and parses full MIME without confusing later messages with context", () => {
  const target = gmail(5);
  if (target.kind !== "gmail") throw Error();
  const msg = (n: number) => ({
    id: `mail${n}`,
    thread_id: "thread",
    internal_date: String(1793975400000 + n * 1000),
    payload: {
      mime_type: "text/plain",
      body: { content: `Message ${n}` },
      headers: [{ name: "From", value: "Valentin" }],
    },
  });
  const page = parseGmailContext({ id: "thread", messages: [msg(2), msg(6)] }, target.message);
  expect(selectContext(target, page.sources).messages.map((x) => x.message.text)).toEqual([
    "Message 2",
  ]);
  expect(() => parseGmailContext({ id: "other", messages: [] }, target.message)).toThrow();
});
