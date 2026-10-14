// @effect-diagnostics nodeBuiltinImport:off - Private bootstrap boundary; never copies historical databases or writes the source.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const SAFE_ENTRIES = ["AGENTS.md", "skills", "agents"] as const;
const PRIVATE_CONFIG = [
  'model = "gpt-6.1-sol"',
  'model_reasoning_effort = "high"',
  'cli_auth_credentials_store = "file"',
  'forced_login_method = "chatgpt"',
  "[features]",
  "multi_agent = true",
  "apps = true",
  "computer_use = false",
  "browser_use = false",
  "in_app_browser = false",
  "",
].join("\n");

export async function seedPrivateCodexHome(home: string, source?: string) {
  await NodeFSP.mkdir(home, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(home, 0o700);
  if (source) {
    const resolvedSource = await NodeFSP.realpath(source);
    if ((await NodeFSP.realpath(home)) === resolvedSource)
      throw new Error("Codex source and private state must differ");
    // Preserve refreshes performed in the private home; never link credentials to the daily installation.
    const auth = await NodeFSP.readFile(NodePath.join(resolvedSource, "auth.json"));
    try {
      JSON.parse(auth.toString("utf8"));
    } catch {
      throw new Error("Invalid source Codex authentication");
    }
    try {
      await NodeFSP.writeFile(NodePath.join(home, "auth.json"), auth, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await NodeFSP.chmod(NodePath.join(home, "auth.json"), 0o600);
    const additionalSkills = NodePath.join(NodePath.dirname(resolvedSource), ".agents", "skills");
    try {
      await NodeFSP.cp(additionalSkills, NodePath.join(home, "skills"), {
        recursive: true,
        dereference: true,
        force: false,
        errorOnExist: false,
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const name of SAFE_ENTRIES) {
      try {
        await NodeFSP.cp(NodePath.join(resolvedSource, name), NodePath.join(home, name), {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: false,
        });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  try {
    await NodeFSP.writeFile(NodePath.join(home, "config.toml"), PRIVATE_CONFIG, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  return home;
}

export async function isolateHarnessCodex(home: string, source: string) {
  const codexHome = await seedPrivateCodexHome(NodePath.join(home, "codex"), source);
  const file = NodePath.join(home, "userdata", "settings.json");
  const settings = JSON.parse(await NodeFSP.readFile(file, "utf8")) as {
    providerInstances?: Record<
      string,
      {
        driver?: string;
        config?: { setupMode?: string; homePath?: string; shadowHomePath?: string };
      }
    >;
  };
  const instance = settings.providerInstances?.codex;
  if (!instance || instance.driver !== "codex" || instance.config?.setupMode !== "existing")
    throw new Error("Expected the existing native Codex harness profile");
  if (instance.config.homePath?.trim() && NodePath.resolve(instance.config.homePath) !== codexHome)
    throw new Error("An explicit Codex home must be reviewed before isolation");
  if (instance.config.shadowHomePath?.trim())
    throw new Error("Shadow Codex state cannot be included safely in harness rollback");
  instance.config.homePath = codexHome;
  const temporary = `${file}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await NodeFSP.rename(temporary, file);
  return codexHome;
}
