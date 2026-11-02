#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Local desktop install/launch boundary; the app and server own their Effect runtimes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import { run } from "./lib/runtime-maintenance/commands.ts";
import { decodeConfig } from "./lib/runtime-maintenance/config.ts";
import { currentRelease, writeJson } from "./lib/runtime-maintenance/state.ts";
import { sessionState } from "./lib/harness-remote/health.ts";
import { resolveElectronLaunchCommand } from "../apps/desktop/scripts/electron-launcher.mjs";

const root = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const desktop = NodePath.join(root, "apps/desktop");
const home = NodePath.join(root, ".t3/travail-desktop");
const state = NodePath.join(home, "userdata");
const client = NodePath.join(home, "client");
const icon = NodePath.join(root, "assets/travail/icon.png");
const mode = process.argv[2] ?? "start";

function build(program: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(program, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Build failed (${code}).`)),
    );
  });
}

function jsonObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid local configuration.");
  }
  return value as Record<string, unknown>;
}

async function readJson(file: string) {
  try {
    return jsonObject(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function prepare() {
  const config = decodeConfig(
    await readJson(NodePath.join(root, ".t3/harness-operations/config.json")),
  );
  await run({ program: "systemctl", args: ["--user", "start", "mt-harness.service"] }, root);
  const origin = `http://127.0.0.1:${config.port}`;
  // systemd Type=simple returns before the HTTP listener is ready on a cold boot.
  let discovery: Response | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      discovery = await fetch(`${origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(2_000),
      });
      break;
    } catch {
      await NodeTimersPromises.setTimeout(250);
    }
  }
  if (!discovery) throw new Error("The harness did not become available.");
  const metadata = await discovery.json();
  if (!discovery.ok || metadata.environmentId !== config.environmentId) {
    throw new Error("The running harness does not match Travail's configured environment.");
  }
  await NodeFSP.mkdir(state, { recursive: true, mode: 0o700 });
  const settingsPath = NodePath.join(state, "desktop-settings.json");
  const settings = (await readJson(settingsPath)) ?? {};
  // The service owns the existing database, tunnel and agents even when the window closes.
  await writeJson(settingsPath, { ...settings, localEnvironmentEnabled: false });

  const release = await currentRelease(config.operations);
  const cli = NodePath.join(release, "apps/server/dist/bin.mjs");
  const sessionPath = NodePath.join(home, "session.private.json");
  let session = await readJson(sessionPath);
  if (
    !session ||
    typeof session.token !== "string" ||
    !(await sessionState(origin, session.token, 2)).authenticated
  ) {
    session = jsonObject(
      await run(
        {
          program: process.execPath,
          args: [
            cli,
            "auth",
            "session",
            "issue",
            "--base-dir",
            config.home,
            "--label",
            "Travail Desktop",
            "--subject",
            "travail-desktop",
            "--ttl",
            "30d",
            "--json",
          ],
        },
        release,
      ),
    );
    if (typeof session.token !== "string") throw new Error("Could not create the desktop session.");
    await writeJson(sessionPath, session);
  }
  const connection = {
    connectionId: "travail:harness",
    environmentId: config.environmentId,
    label: "Travail — ce PC",
  };
  await writeJson(NodePath.join(state, "harness-connection.private.json"), {
    _tag: "BearerConnectionRegistration",
    target: { _tag: "BearerConnectionTarget", ...connection },
    profile: {
      _tag: "BearerConnectionProfile",
      ...connection,
      httpBaseUrl: origin,
      wsBaseUrl: origin.replace("http:", "ws:"),
    },
    credential: { _tag: "BearerConnectionCredential", token: session.token },
  });
}

async function install() {
  const vp = NodePath.join(root, "node_modules/.bin/vp");
  await build(vp, ["build", "--outDir", client], NodePath.join(root, "apps/web"));
  await build(process.execPath, ["scripts/build-browser-secret.mjs"], desktop);
  await build(process.execPath, ["scripts/build-preview-annotation-css.mjs"], desktop);
  await build(vp, ["pack"], desktop);
  resolveElectronLaunchCommand();
  await installLauncher();
}

async function installLauncher() {
  const bin = NodePath.join(NodeOS.homedir(), ".local/bin/travail");
  const applications = NodePath.join(NodeOS.homedir(), ".local/share/applications");
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await NodeFSP.mkdir(NodePath.dirname(bin), { recursive: true });
  await NodeFSP.mkdir(applications, { recursive: true });
  const node = await NodeFSP.realpath(process.execPath);
  await NodeFSP.writeFile(
    bin,
    `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(NodePath.join(root, "scripts/harness-desktop.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  // The installation paths here are local absolute paths, never a shell command.
  const entryQuote = (value: string) =>
    `"${value.replaceAll("\\", "\\\\\\\\").replaceAll('"', '\\\\"').replaceAll("$", "\\\\$").replaceAll("`", "\\\\`").replaceAll("%", "%%")}"`;
  await NodeFSP.writeFile(
    NodePath.join(applications, "travail.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Travail",
      "Comment=Harness personnel basé sur MT Code et T3 Code",
      `Exec=${entryQuote(bin)} start %U`,
      `Icon=${icon}`,
      "Terminal=false",
      "Categories=Development;",
      "StartupWMClass=travail",
      "StartupNotify=true",
      "MimeType=x-scheme-handler/t3code;x-scheme-handler/travail;",
      "",
    ].join("\n"),
  );
  console.log("Travail est installé : menu des applications ou commande travail.");
}

try {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone local installer boundary.
  if (NodeOS.platform() !== "linux")
    throw new Error("This local installer currently targets Linux.");
  if (mode === "install") {
    await install();
  } else if (mode === "install-launcher") {
    await installLauncher();
  } else if (mode === "start" || mode === "prepare") {
    await prepare();
    if (mode === "start") {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        T3CODE_HOME: home,
        T3CODE_DESKTOP_DISTRO: "travail",
        T3CODE_DESKTOP_CLIENT_ASSETS: client,
        T3CODE_DISABLE_AUTO_UPDATE: "true",
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.VITE_DEV_SERVER_URL;
      const command = resolveElectronLaunchCommand([
        NodePath.join(desktop, "dist-electron/main.cjs"),
        ...process.argv.slice(3),
      ]);
      const child = NodeChildProcess.spawn(command.electronPath, command.args, {
        cwd: desktop,
        env,
        stdio: "inherit",
      });
      child.once("error", () => {
        console.error("Travail could not start Electron.");
        process.exitCode = 1;
      });
      child.once("exit", (code) => {
        process.exitCode = code ?? 1;
      });
    }
  } else {
    throw new Error(
      "Usage: node scripts/harness-desktop.ts [install|install-launcher|start|prepare]",
    );
  }
} catch {
  console.error(
    "Travail n'a pas pu démarrer ou s'installer. Vérifie le service mt-harness et les fichiers de l'installation.",
  );
  process.exitCode = 1;
}
