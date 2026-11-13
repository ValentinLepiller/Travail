// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Standalone connector process materializes files for the provider, outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type { ChatImageAttachment, SlackTaskMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    file_id: Schema.String,
    mime_type: Schema.String,
    file_uri: Schema.Struct({ download_url: Schema.String, mime_type: Schema.String }),
  }),
);
const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const maxBytes = 10 * 1024 * 1024;

export async function readSlackImage(
  workspaceId: string,
  file: NonNullable<SlackTaskMessage["files"]>[number],
  attachmentsDir: string,
  call: (operation: "slack.file", args: Record<string, unknown>) => Promise<unknown>,
): Promise<ChatImageAttachment> {
  const result = decode(await call("slack.file", { file_id: file.id }));
  if (
    result.file_id !== file.id ||
    result.mime_type !== file.mimeType ||
    result.file_uri.mime_type !== file.mimeType ||
    !supported.has(file.mimeType)
  )
    throw new Error("Unsupported Slack image");
  const url = new URL(result.file_uri.download_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname.endsWith(".oaiusercontent.com") || url.hostname === "files.slack.com")
  )
    throw new Error("Unexpected connector file host");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("Slack image download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.length;
      if (sizeBytes > maxBytes) throw new Error("Slack image too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (!sizeBytes) throw new Error("Empty Slack image");
  const bytes = Buffer.concat(chunks);
  if (fileHeaderMimeType(bytes.subarray(0, 32)) !== file.mimeType)
    throw new Error("Slack file is not the declared image format");
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const id = createDeterministicAttachmentId("slack", `${workspaceId}:${file.id}:${digest}`)!;
  const attachment: ChatImageAttachment = {
    type: "image",
    id,
    name: file.name.slice(0, 255),
    mimeType: file.mimeType,
    sizeBytes,
  };
  const target = resolveAttachmentPath({ attachmentsDir, attachment });
  if (!target) throw new Error("Invalid attachment path");
  await NodeFSP.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  return attachment;
}
