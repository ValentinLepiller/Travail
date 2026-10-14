// @effect-diagnostics nodeBuiltinImport:off - Bootstrap filesystem boundary runs before the MT service runtime starts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const HARNESS_CODEX_LAUNCH_ARGS =
  "--enable multi_agent --disable computer_use --disable browser_use --disable in_app_browser";

export async function prepareHarnessHome(home: string): Promise<void> {
  const stateDirectory = NodePath.join(home, "userdata");
  await NodeFSP.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  // Seed only a fresh environment. Subsequent launches preserve settings edited in MT.
  try {
    await NodeFSP.writeFile(
      NodePath.join(stateDirectory, "settings.json"),
      JSON.stringify(
        {
          environmentLabel: "Valentin · MT Harness",
          enableProviderUpdateChecks: false,
          desktopControl: { enabled: false },
          providerInstances: {
            codex: {
              driver: "codex",
              enabled: true,
              displayName: "Codex · abonnement ChatGPT",
              config: {
                setupMode: "existing",
                binaryPath: "codex",
                homePath: NodePath.join(home, "codex"),
                launchArgs: HARNESS_CODEX_LAUNCH_ARGS,
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}
