// @effect-diagnostics nodeBuiltinImport:off -- Tests the standalone connector's file and download boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { readSlackImage } from "./slackImages.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { inspectSource } from "./inspectSource.ts";
const file = { id: "F123", name: "Plan.png", mimeType: "image/png" };
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL9kAAAAASUVORK5CYII=",
  "base64",
);
const envelope = (download_url = "https://files.example.oaiusercontent.com/image") => ({
  file_id: file.id,
  mime_type: file.mimeType,
  file_uri: { download_url, mime_type: file.mimeType },
});
afterEach(() => vi.unstubAllGlobals());
it("materializes a Slack image for the provider without retaining the signed URL", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "slack-image-"));
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const attachment = await readSlackImage("T1", file, dir, async (op, args) => {
      expect(op).toBe("slack.file");
      expect(args).toEqual({ file_id: file.id });
      return envelope();
    });
    expect(
      await NodeFSP.readFile(resolveAttachmentPath({ attachmentsDir: dir, attachment })!),
    ).toEqual(bytes);
    expect(JSON.stringify(attachment)).not.toContain("https");
    expect(await readSlackImage("T1", file, dir, async () => envelope())).toEqual(attachment);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
it("refuses unexpected download hosts and oversized or non-image responses", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "slack-image-"));
  try {
    const download = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", download);
    await expect(
      readSlackImage("T1", file, dir, async () => envelope("http://127.0.0.1/private")),
    ).rejects.toThrow("host");
    expect(download).not.toHaveBeenCalled();
    download.mockImplementation(async () => new Response("<html>expired</html>"));
    await expect(readSlackImage("T1", file, dir, async () => envelope())).rejects.toThrow(
      "image format",
    );
    download.mockImplementation(
      async () => new Response(bytes, { headers: { "content-length": "11000000" } }),
    );
    await expect(readSlackImage("T1", file, dir, async () => envelope())).rejects.toThrow(
      "download failed",
    );
    expect(await NodeFSP.readdir(dir)).toEqual([]);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
it("keeps the detailed forward and its image when channel history has an empty copy, and reports unread images", async () => {
  const source = {
    kind: "slack" as const,
    message: {
      workspaceId: "T1",
      channelId: "C1",
      channelName: "test",
      authorId: "U1",
      ts: "1794335695.576729",
      threadTs: "1794335695.576729",
      text: "",
    },
  };
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "slack-inspection-"));
  const call = async (op: string) =>
    op === "slack.file"
      ? envelope()
      : op === "slack.read"
        ? {
            messages: `=== THREAD PARENT MESSAGE ===\nFrom: Arnaud (U1)\nTime: now\nMessage TS: ${source.message.ts}\nForwarded message from Carlos: Wi-Fi Madrid\nFiles: Plan.png (ID: F123, image/png, 2 KB)\n`,
            pagination_info: "There are no more messages in this thread.",
          }
        : {
            messages: `Channel: test (C1)\n\n=== Message from Arnaud (U1) at now ===\nMessage TS: ${source.message.ts}\n\n`,
            pagination_info: "There are no more messages",
          };
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes)),
    );
    const result = await inspectSource(source, call, undefined, dir);
    expect(result.text).toContain("Carlos");
    expect(result.text).toContain('"authorName":"Arnaud"');
    expect(result.images?.[0]).toMatchObject({
      messageTs: source.message.ts,
      fileId: "F123",
      attachment: { type: "image" },
    });
    expect(result.status).toBe("ready");
    const failed = await inspectSource(
      source,
      async (op) => {
        if (op === "slack.file") throw Error("no access");
        return call(op);
      },
      undefined,
      dir,
    );
    expect(failed.status).toBe("partial");
    expect(failed.images).toBeUndefined();
    expect(failed.text).toContain("contenu non lu");
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
