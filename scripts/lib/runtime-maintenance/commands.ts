// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Bounded external process boundary, output intentionally discarded.
import * as NodeChildProcess from "node:child_process";

export interface Command {
  readonly program: string;
  readonly args: readonly string[];
}
export function run(
  command: Command,
  cwd: string,
  timeoutMs = 120_000,
  env = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command.program, [...command.args], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 65_536) chunks.push(chunk);
    });
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Command could not start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (code === 0 && !timedOut) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error(timedOut ? "Command timed out" : `Command exited ${code}`));
    });
  });
}
