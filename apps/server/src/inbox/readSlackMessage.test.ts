import { expect, it } from "vite-plus/test";
import { readSlackMessage } from "./readSlackMessage.ts";

const target = {
  workspaceId: "T1",
  channelId: "C1",
  channelName: "test",
  authorId: "U1",
  ts: "1794335695.576729",
  threadTs: "1794335695.576729",
  text: "",
};
const page = (text: string, author = "U1") => ({
  messages: `=== THREAD PARENT MESSAGE ===\nFrom: Arnaud (${author})\nTime: now\nMessage TS: ${target.ts}\n${text}\n`,
  pagination_info: "There are no more messages in this thread.",
});
it("recovers a forwarded message and image metadata without attributing it to Valentin", async () => {
  const message = await readSlackMessage(target, async () =>
    page(
      "Forwarded message from Carlos: Hello Arnaud! Configure the Madrid Wi-Fi?\nFiles: Plan.png (ID: F123, image/png, 2 KB)",
    ),
  );
  expect(message).toMatchObject({
    authorId: "U1",
    authorName: "Arnaud",
    text: expect.stringContaining("Carlos"),
    files: [{ id: "F123", name: "Plan.png", mimeType: "image/png" }],
  });
});
it("refuses a different author or a missing message instead of collecting an empty success", async () => {
  await expect(readSlackMessage(target, async () => page("Other", "U2"))).rejects.toThrow(
    "author mismatch",
  );
  await expect(
    readSlackMessage({ ...target, ts: "1794335696.000000" }, async () => page("Other")),
  ).rejects.toThrow("target message unavailable");
});
it("recovers a reply from a later page while preserving the thread identity", async () => {
  let calls = 0;
  const result = await readSlackMessage(
    { ...target, ts: "1794335696.000000" },
    async (_op, args) => {
      calls++;
      if (!args.cursor) return { ...page("Parent"), pagination_info: "use cursor: `next`" };
      return {
        ...page("Parent"),
        messages:
          page("Parent").messages +
          "=== THREAD REPLIES (1 total) ===\n--- Reply 1 of 1 ---\nFrom: Arnaud (U1)\nTime: now\nMessage TS: 1794335696.000000\nForwarded message from Carlos: A reply\n",
      };
    },
  );
  expect(calls).toBe(2);
  expect(result.text).toContain("A reply");
  expect(result.threadTs).toBe(target.threadTs);
});
