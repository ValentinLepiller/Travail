// @effect-diagnostics nodeBuiltinImport:off - Protocol fixtures, no external accounts.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { openNativeApps } from "./native.ts";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true, force: true })),
  );
});
async function fakeRuntime(source: string) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-native-"));
  homes.push(home);
  const binary = NodePath.join(home, "codex-fixture");
  await NodeFSP.writeFile(binary, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return binary;
}

it("isolates Desktop environment and correlates replies while rejecting interactive challenges", async () => {
  vi.stubEnv("CODEX_APP_TOOLS_PIPE_PATH", "fixture-desktop-pipe");
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "fixture-desktop-identity");
  vi.stubEnv("CODEX_HOME", "/fixture/account-home");
  const binary = await fakeRuntime(`
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (v) => console.log(JSON.stringify(v));
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') { reply({ id: m.id, method: 'fixture/authorization', params: {} }); reply({ id: m.id, result: {} }); }
  if (m.method === 'fixture/env') reply({ id: m.id, result: { injected: Object.keys(process.env).filter(k => k.startsWith('CODEX_') && k !== 'CODEX_HOME'), home: process.env.CODEX_HOME } });
  if (m.method === 'fixture/error') reply({ id: m.id, error: { code: -32001, message: 'SECRET_FIXTURE' } });
  if (m.method === 'fixture/stringChallenge') { reply({ id: 'challenge', method: 'fixture/authorization', params: {} }); reply({ id: m.id, result: {} }); }
});`);
  const client = await openNativeApps(binary);
  try {
    expect(await client.rpc("fixture/env", {})).toEqual({
      injected: [],
      home: "/fixture/account-home",
    });
    await expect(client.rpc("fixture/error", {})).rejects.toThrow("Codex RPC -32001 failed");
    expect(await client.rpc("fixture/stringChallenge", {})).toEqual({});
  } finally {
    client.close();
  }
  await expect(client.rpc("fixture/env", {})).rejects.toThrow("closed");
});

it("rejects startup failures without waiting for the timeout", async () => {
  await expect(openNativeApps(await fakeRuntime("process.exit(1)"))).rejects.toThrow("exited");
});
