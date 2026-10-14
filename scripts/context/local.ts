// @effect-diagnostics nodeBuiltinImport:off - Read-only, bounded local context, independent of server runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 10_000;
export const defaultCodexHome = () =>
  process.env.MT_CONTEXT_CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");

async function confinedFile(root: string, path: string) {
  const base = await NodeFSP.realpath(root);
  const file = await NodeFSP.realpath(NodePath.resolve(base, path));
  const rel = NodePath.relative(base, file);
  if (rel === ".." || rel.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(rel))
    throw new Error("Context path escapes its allowed source root");
  return file;
}

/** Only a bounded prefix is read; provenance and omitted data stay visible to the caller. */
export async function readLines(root: string, path: string) {
  const file = await confinedFile(root, path);
  const handle = await NodeFSP.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Context source must be a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const partial = bytesRead < stat.size;
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (partial) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
    const all = text.split("\n", MAX_LINES + 1);
    return {
      source: file,
      lines: all.slice(0, MAX_LINES),
      truncated: partial || all.length > MAX_LINES,
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

function limitCount(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Limit must be an integer between 1 and 20");
  return limit;
}
function queryText(query: string) {
  const text = query.trim().toLocaleLowerCase();
  if (!text || text.length > 200) throw new Error("A query of 1 to 200 characters is required");
  return text;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function json(line: string) {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export async function searchMemory(query: string, limit = 5, home = defaultCodexHome()) {
  const needle = queryText(query);
  const count = limitCount(limit);
  const data = await readLines(NodePath.join(home, "memories"), "MEMORY.md");
  const matches = data.lines
    .flatMap((text, index) =>
      text.toLocaleLowerCase().includes(needle)
        ? [{ line: index + 1, text: text.slice(0, 800) }]
        : [],
    )
    .slice(0, count);
  return {
    source: data.source,
    matches,
    truncated: data.truncated,
    scope: "MEMORY.md only; follow explicit references with memory-read",
  };
}

export async function readMemory(path: string, start = 1, count = 40, home = defaultCodexHome()) {
  if (!path.endsWith(".md")) throw new Error("Memory reading accepts Markdown only");
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("Use a positive start line and 1 to 100 lines");
  const data = await readLines(NodePath.join(home, "memories"), path);
  return {
    source: data.source,
    lines: data.lines
      .slice(start - 1, start - 1 + count)
      .map((text, i) => ({ line: start + i, text: text.slice(0, 1200) })),
    truncated: data.truncated,
    availablePrefixLines: data.lines.length,
  };
}

export async function searchHistory(query: string, limit = 5, home = defaultCodexHome()) {
  const needle = queryText(query);
  const count = limitCount(limit);
  const data = await readLines(home, "session_index.jsonl");
  const matches = data.lines
    .flatMap((line) => {
      const item = json(line);
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.thread_name !== "string" ||
        !item.thread_name.toLocaleLowerCase().includes(needle)
      )
        return [];
      return [{ id: item.id, title: item.thread_name.slice(0, 300), updatedAt: item.updated_at }];
    })
    .slice(-count)
    .toReversed();
  return {
    source: data.source,
    matches,
    truncated: data.truncated,
    scope: "Titles in bounded local index only; no body search or full import",
  };
}

export async function readHistory(path: string, limit = 5, home = defaultCodexHome()) {
  const count = limitCount(limit);
  const source = path.replaceAll("\\", "/");
  const root = source.startsWith("archived_sessions/") ? "archived_sessions" : "sessions";
  if (!source.startsWith(`${root}/`) || !source.endsWith(".jsonl"))
    throw new Error("History path must be a sessions/ or archived_sessions/ JSONL file");
  const data = await readLines(NodePath.join(home, root), source.slice(root.length + 1));
  const messages: { line: number; role: string; text: string }[] = [];
  let session: { id: unknown; cwd: unknown } | undefined;
  for (const [index, line] of data.lines.entries()) {
    const item = json(line);
    const payload = object(item?.payload);
    if (!payload) continue;
    if (item?.type === "session_meta") session = { id: payload.id, cwd: payload.cwd };
    if (
      item?.type !== "response_item" ||
      payload.type !== "message" ||
      !["user", "assistant"].includes(String(payload.role))
    )
      continue;
    const text = (Array.isArray(payload.content) ? payload.content : [])
      .flatMap((value) => {
        const part = object(value);
        return ["input_text", "output_text", "text"].includes(String(part?.type)) &&
          typeof part?.text === "string"
          ? [part.text]
          : [];
      })
      .join("\n");
    if (text)
      messages.push({ line: index + 1, role: String(payload.role), text: text.slice(0, 1200) });
  }
  return {
    source: data.source,
    session,
    messages: messages.slice(-count),
    truncated: data.truncated,
    scope:
      "User/assistant text in bounded prefix only; excludes tool outputs, system/developer messages and authentication files",
  };
}
