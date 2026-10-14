// @effect-diagnostics nodeBuiltinImport:off - Seal the same runtime-external closure the upstream bundler ships.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { selectCliRuntimeExternalDependencies } from "../cli-external-packages.ts";

export async function runtimePackages(release: string) {
  const manifest = NodePath.join(release, "apps", "server", "package.json");
  const packageJson = JSON.parse(await NodeFSP.readFile(manifest, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const found = new Map<string, string>();
  async function visit(name: string, from: string, optional = false): Promise<void> {
    let directory: string | undefined;
    for (const search of NodeModule.createRequire(from).resolve.paths(name) ?? []) {
      try {
        directory = await NodeFSP.realpath(NodePath.join(search, name));
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (!directory) {
      if (optional) return;
      throw new Error(`Missing runtime dependency ${name}`);
    }
    if (found.has(directory)) return;
    const file = NodePath.join(directory, "package.json");
    const dependency = JSON.parse(await NodeFSP.readFile(file, "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    found.set(directory, `${dependency.name}@${dependency.version}`);
    for (const child of Object.keys(dependency.dependencies ?? {}).sort())
      await visit(child, file, child in (dependency.optionalDependencies ?? {}));
    for (const child of Object.keys(dependency.optionalDependencies ?? {}).sort())
      await visit(child, file, true);
  }
  for (const name of Object.keys(
    selectCliRuntimeExternalDependencies(packageJson.dependencies),
  ).sort())
    await visit(name, manifest);
  return [...found]
    .map(([directory, name]) => ({ directory, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
