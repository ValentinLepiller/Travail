// @effect-diagnostics nodeBuiltinImport:off - Temporary read-only source fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { readHistory, readLines, readMemory, searchHistory, searchMemory } from "./local.ts";

const homes: string[] = [];
async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-context-"));
  homes.push(home);
  await NodeFSP.mkdir(NodePath.join(home, "memories"));
  await NodeFSP.mkdir(NodePath.join(home, "sessions"));
  return home;
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true, force: true })),
  );
});

it("retains memory provenance and line numbers without modifying its source", async () => {
  const home = await fixture();
  const content = "# Memory\nBounded fixture decision\nAnother fixture decision\n";
  const path = NodePath.join(home, "memories", "MEMORY.md");
  await NodeFSP.writeFile(path, content);
  const result = await searchMemory("fixture", 1, home);
  expect(result.source).toBe(path);
  expect(result.matches).toEqual([{ line: 2, text: "Bounded fixture decision" }]);
  expect((await readMemory("MEMORY.md", 2, 1, home)).lines).toEqual(result.matches);
  expect(await NodeFSP.readFile(path, "utf8")).toBe(content);
});

it("reads only titles from the session index and reports malformed entries without body scanning", async () => {
  const home = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(home, "session_index.jsonl"),
    [
      "bad-json",
      JSON.stringify({ id: "one", thread_name: "Fixture old", updated_at: "2026-01-01" }),
      JSON.stringify({ id: "two", thread_name: "Fixture new", updated_at: "2026-02-01" }),
    ].join("\n"),
  );
  expect((await searchHistory("fixture", 1, home)).matches).toEqual([
    { id: "two", title: "Fixture new", updatedAt: "2026-02-01" },
  ]);
});

it("extracts conversation text but excludes tool, system and developer payloads", async () => {
  const home = await fixture();
  const events = [
    { type: "session_meta", payload: { id: "fixture-id", cwd: "/fixture/project" } },
    ...["user", "assistant", "system", "developer"].map((role) => ({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [
          { type: role === "assistant" ? "output_text" : "input_text", text: `${role} fixture` },
        ],
      },
    })),
    {
      type: "response_item",
      payload: { type: "function_call_output", output: "TOOL_SECRET_FIXTURE" },
    },
  ];
  await NodeFSP.writeFile(
    NodePath.join(home, "sessions", "fixture.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  const result = await readHistory("sessions/fixture.jsonl", 5, home);
  expect(result.session).toEqual({ id: "fixture-id", cwd: "/fixture/project" });
  expect(result.messages.map((m) => m.text)).toEqual(["user fixture", "assistant fixture"]);
});

it("rejects traversal, symlinks leaving the source root and auth files", async () => {
  const home = await fixture();
  await NodeFSP.writeFile(NodePath.join(home, "auth.json"), "SECRET_FIXTURE");
  await NodeFSP.writeFile(NodePath.join(home, "outside.md"), "SECRET_FIXTURE");
  await NodeFSP.symlink(
    NodePath.join(home, "outside.md"),
    NodePath.join(home, "memories", "escape.md"),
  );
  await expect(readMemory("../outside.md", 1, 5, home)).rejects.toThrow("escapes");
  await expect(readMemory("escape.md", 1, 5, home)).rejects.toThrow("escapes");
  await expect(readMemory("auth.json", 1, 5, home)).rejects.toThrow("Markdown");
  await expect(readHistory("sessions/../auth.json", 5, home)).rejects.toThrow("JSONL");
});

it("reports a bounded prefix and validates limits", async () => {
  const home = await fixture();
  await NodeFSP.writeFile(
    NodePath.join(home, "memories", "MEMORY.md"),
    `${"fixture\n".repeat(400_000)}TAIL`,
  );
  const result = await readLines(NodePath.join(home, "memories"), "MEMORY.md");
  expect(result.truncated).toBe(true);
  expect(result.bytesRead).toBe(2 * 1024 * 1024);
  expect(result.lines).toHaveLength(10_000);
  await expect(searchMemory("", 5, home)).rejects.toThrow("query");
  await expect(searchHistory("fixture", 21, home)).rejects.toThrow("Limit");
});
