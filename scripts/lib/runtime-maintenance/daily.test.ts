// @effect-diagnostics nodeBuiltinImport:off - Validation launches only bounded local fixture commands.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { validate } from "./daily.ts";
import { decodeConfig, type RuntimeConfig } from "./config.ts";
import { requiredUsages } from "./promotion.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-validation-"));
  roots.push(root);
  for (const [path, body] of [
    ["apps/server/package.json", '{"dependencies":{}}'],
    ["apps/server/dist/bin.mjs", "fixture"],
    ["apps/server/src/cloud/serviceProtocol.ts", "protocol"],
    ["scripts/harness.ts", "fixture"],
    ["scripts/lib/codex-home.ts", "private bootstrap"],
    ["scripts/lib/harness-home.ts", "fixture"],
    ["pnpm-lock.yaml", "fixture"],
  ]) {
    const file = NodePath.join(root, path!);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, body!);
  }
  const checks = Object.fromEntries(
    requiredUsages.map((usage) => [
      usage,
      [
        {
          program: process.execPath,
          args: [
            "--eval",
            'if(!process.env.HARNESS_HOME.includes("validation") || process.env.HARNESS_TAILSCALE_SERVE!=="0") process.exit(1)',
          ],
        },
      ],
    ]),
  );
  const config: RuntimeConfig = {
    source: root,
    home: root,
    operations: root,
    port: 3773,
    timezone: "Europe/Paris",
    environmentId: "fixture",
    nativeCodex: NodePath.join(root, "native-codex.mjs"),
    path: process.env.PATH ?? "",
    prepareUpdates: false,
    adaptWithAgent: false,
    promoteValidated: false,
    agentTimeoutMs: 1000,
    commandTimeoutMs: 1000,
    mt: { url: "https://example.invalid/mt", ref: "refs/heads/main" },
    t3: { url: "https://example.invalid/t3", ref: "refs/heads/main" },
    checks,
    postPromotionChecks: [],
  };
  await NodeFSP.mkdir(NodePath.join(root, "codex"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, "codex/auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture" } }),
  );
  await NodeFSP.writeFile(config.nativeCodex, 'console.log("codex-cli 0.165.0")');
  const installed = NodePath.join(root, "installed");
  await NodeFSP.mkdir(installed);
  await NodeFSP.symlink(installed, NodePath.join(root, "current"));
  return { root, config };
}
it("requires all configured usage checks to pass in an isolated state", async () => {
  const f = await fixture();
  const receipt = await validate(f.config, f.root);
  expect(Object.values(receipt.usages)).toEqual(Array(7).fill(true));
  expect(
    JSON.parse(await NodeFSP.readFile(NodePath.join(f.root, ".t3/validation.json"), "utf8")),
  ).toEqual(receipt);
});
it("does not issue a successful receipt if a required usage is missing or fails", async () => {
  const f = await fixture();
  f.config.checks.agents = [];
  await expect(validate(f.config, f.root)).rejects.toThrow("No validation configured");
  f.config.checks.agents = [{ program: process.execPath, args: ["--eval", "process.exit(7)"] }];
  await expect(validate(f.config, f.root)).rejects.toThrow("exited 7");
  await expect(NodeFSP.access(NodePath.join(f.root, ".t3/validation.json"))).rejects.toThrow();
});
it("rejects unbounded agent limits and malformed operations config", async () => {
  const f = await fixture();
  expect(() => decodeConfig(f.config)).not.toThrow();
  expect(() => decodeConfig({ ...f.config, agentTimeoutMs: 0 })).toThrow("Timeout");
  expect(() => decodeConfig({ ...f.config, agentTimeoutMs: 2_000_000 })).toThrow("Timeout");
  expect(() => decodeConfig({ ...f.config, timezone: "invalid/zone" })).toThrow();
});

it("exercises the candidate Codex rather than the current release wrapper", async () => {
  const f = await fixture();
  const oldBin = NodePath.join(f.root, "provider-bin");
  await NodeFSP.mkdir(oldBin);
  await NodeFSP.writeFile(NodePath.join(oldBin, "codex"), "#!/bin/sh\nexit 9\n", { mode: 0o700 });
  f.config.path = oldBin + NodePath.delimiter + (process.env.PATH ?? "");
  const provider = NodePath.join(f.root, ".harness-provider");
  const bin = NodePath.join(provider, "node_modules/.bin");
  const code = NodePath.join(provider, "node_modules/@openai/codex/bin");
  await NodeFSP.mkdir(bin, { recursive: true });
  await NodeFSP.mkdir(code, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(provider, "package-lock.json"), "{}");
  await NodeFSP.writeFile(
    NodePath.join(code, "codex.js"),
    '#!/usr/bin/env node\nconsole.log("codex-cli 0.165.0")\n',
    { mode: 0o700 },
  );
  await NodeFSP.symlink("../@openai/codex/bin/codex.js", NodePath.join(bin, "codex"));
  f.config.checks.agents = [{ program: "codex", args: ["--version"] }];
  expect((await validate(f.config, f.root)).usages.agents).toBe(true);
});

it("rejects a stale dedicated Codex runtime before launching the usage checks", async () => {
  const f = await fixture();
  const provider = NodePath.join(f.root, ".harness-provider/node_modules/@openai/codex/bin");
  await NodeFSP.mkdir(provider, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(provider, "codex.js"), 'console.log("codex-cli 0.159.3")');
  f.config.checks.agents = [{ program: process.execPath, args: ["--eval", "process.exit(99)"] }];
  await expect(validate(f.config, f.root)).rejects.toThrow(
    "Candidate Codex 0.159.3 is older than installed 0.165.0",
  );
  await expect(NodeFSP.access(NodePath.join(f.root, ".t3/validation.json"))).rejects.toThrow();
});
