// @effect-diagnostics nodeBuiltinImport:off - Isolated filesystem fixtures for the launcher bootstrap.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CodexSettings,
  ServerSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { prepareHarnessHome } from "./harness-home.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const codexInstanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const homes: string[] = [];
async function freshHome() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-harness-"));
  homes.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => NodeFSP.rm(home, { recursive: true, force: true })),
  );
});

it("boots a valid native Codex environment with desktop control disabled", async () => {
  const home = await freshHome();
  await prepareHarnessHome(home);
  const settings = decodeSettings(
    JSON.parse(await NodeFSP.readFile(NodePath.join(home, "userdata", "settings.json"), "utf8")),
  );
  const codex = decodeCodexSettings(settings.providerInstances[codexInstanceId]?.config);
  expect(codex.setupMode).toBe("existing");
  expect(codex.homePath).toBe(NodePath.join(home, "codex"));
  expect(settings.desktopControl.enabled).toBe(false);
  expect(settings.enableProviderUpdateChecks).toBe(false);
});

it("preserves user settings verbatim across repeated and concurrent launches", async () => {
  const home = await freshHome();
  await prepareHarnessHome(home);
  const file = NodePath.join(home, "userdata", "settings.json");
  const original = '{"environmentLabel":"My edited environment"}\n';
  await NodeFSP.writeFile(file, original);
  await Promise.all([prepareHarnessHome(home), prepareHarnessHome(home)]);
  expect(await NodeFSP.readFile(file, "utf8")).toBe(original);
});

it("propagates a filesystem failure instead of proceeding with unsafe defaults", async () => {
  const home = await freshHome();
  await NodeFSP.writeFile(NodePath.join(home, "userdata"), "not a directory");
  await expect(prepareHarnessHome(home)).rejects.toThrow();
});
