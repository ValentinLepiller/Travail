// @effect-diagnostics nodeBuiltinImport:off - Synthetic credentials and native-state fixtures only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, expect, it } from "vite-plus/test";
import { seedPrivateCodexHome, isolateHarnessCodex } from "./codex-home.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-codex-home-"));
  roots.push(root);
  const source = NodePath.join(root, "daily");
  const target = NodePath.join(root, "harness/codex");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(
    NodePath.join(source, "auth.json"),
    '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-only"}}',
  );
  await NodeFSP.writeFile(NodePath.join(source, "state_5.sqlite"), "do not copy");
  await NodeFSP.mkdir(NodePath.join(source, "skills/example"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "skills/example/SKILL.md"), "synthetic skill");
  return { source, target, root };
}
it("seeds private native auth and skills without importing DB state or linking source credentials", async () => {
  const f = await fixture();
  const before = await NodeFSP.readFile(NodePath.join(f.source, "auth.json"));
  await seedPrivateCodexHome(f.target, f.source);
  expect(await NodeFSP.readFile(NodePath.join(f.target, "auth.json"))).toEqual(before);
  expect((await NodeFSP.stat(f.target)).mode & 0o777).toBe(0o700);
  expect((await NodeFSP.stat(NodePath.join(f.target, "auth.json"))).mode & 0o777).toBe(0o600);
  expect((await NodeFSP.lstat(NodePath.join(f.target, "auth.json"))).isSymbolicLink()).toBe(false);
  await expect(NodeFSP.access(NodePath.join(f.target, "state_5.sqlite"))).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(f.target, "skills/example/SKILL.md"), "utf8")).toBe(
    "synthetic skill",
  );
  await NodeFSP.writeFile(NodePath.join(f.target, "auth.json"), '{"refreshed":"private"}');
  await seedPrivateCodexHome(f.target, f.source);
  expect(await NodeFSP.readFile(NodePath.join(f.source, "auth.json"))).toEqual(before);
  expect(await NodeFSP.readFile(NodePath.join(f.target, "auth.json"), "utf8")).toBe(
    '{"refreshed":"private"}',
  );
});
it("updates only an unset native harness home while preserving other settings", async () => {
  const f = await fixture();
  const home = NodePath.dirname(f.target);
  await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
  const settings = {
    environmentLabel: "preserve",
    providerInstances: {
      codex: {
        driver: "codex",
        config: { setupMode: "existing", launchArgs: "--enable multi_agent", homePath: "" },
      },
    },
  };
  const path = NodePath.join(home, "userdata/settings.json");
  await NodeFSP.writeFile(path, JSON.stringify(settings));
  await isolateHarnessCodex(home, f.source);
  const result = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  expect(result.environmentLabel).toBe("preserve");
  expect(result.providerInstances.codex.config).toEqual({
    ...settings.providerInstances.codex.config,
    homePath: f.target,
  });
  result.providerInstances.codex.config.homePath = "/explicit/user/home";
  await NodeFSP.writeFile(path, JSON.stringify(result));
  await expect(isolateHarnessCodex(home, f.source)).rejects.toThrow("explicit Codex home");
  expect(
    JSON.parse(await NodeFSP.readFile(path, "utf8")).providerInstances.codex.config.homePath,
  ).toBe("/explicit/user/home");
});
