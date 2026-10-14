// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone stdio client, outside Effect services.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object in the connector protocol");
  }
  return value as Record<string, unknown>;
}

/** Starts its own Codex runtime using managed account auth, without Desktop's tool pipe. */
export async function openNativeApps(binary = "codex") {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && key !== "CODEX_HOME") {
      delete env[key];
    }
  }
  const child = NodeChildProcess.spawn(
    binary,
    [
      "--disable",
      "computer_use",
      "--disable",
      "browser_use",
      "--disable",
      "in_app_browser",
      "app-server",
    ],
    {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const lines = NodeReadline.createInterface({ input: child.stdout });
  let nextId = 0;
  let stopped = false;
  function fail(error: Error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  child.on("error", () => {
    stopped = true;
    fail(new Error("Cannot start Codex; check the configured binary"));
  });
  child.on("exit", () => {
    stopped = true;
    fail(new Error("Codex connector runtime exited"));
  });
  child.stdin.on("error", () => {
    stopped = true;
    fail(new Error("Codex connector transport closed"));
  });
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (message.method && (typeof message.id === "number" || typeof message.id === "string")) {
      // Authorization challenges stay in the native Codex client; this adapter never approves them.
      child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive authorization requires the native Codex client" } })}\n`,
      );
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        new Error(
          `Codex RPC ${String(record(message.error).code)} failed; reconnect the app in Codex if authentication expired`,
        ),
      );
    else request.resolve(message.result);
  });
  function rpc(method: string, params: unknown): Promise<unknown> {
    if (stopped) return Promise.reject(new Error("Codex connector runtime closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 45_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) fail(new Error("Codex connector transport closed"));
      });
    });
  }
  function close() {
    stopped = true;
    fail(new Error("Connector client closed"));
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
  try {
    await rpc("initialize", {
      clientInfo: { name: "mt_native_connectors", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    return { rpc, close };
  } catch (error) {
    close();
    throw error;
  }
}

type ConnectorRpc = (method: string, params: unknown) => Promise<unknown>;

export async function installedApps(rpc: ConnectorRpc) {
  const result = record(await rpc("app/installed", { forceRefresh: true }));
  return (Array.isArray(result.apps) ? result.apps : [])
    .map(record)
    .filter((app) =>
      /^(gmail|slack|teams|microsoft teams|whatsapp)$/i.test(String(app.runtimeName)),
    )
    .map(({ id, runtimeName, enabled, callable }) => ({ id, runtimeName, enabled, callable }));
}

export async function connectorThread(rpc: ConnectorRpc) {
  const thread = record(
    record(
      await rpc("thread/start", {
        ephemeral: true,
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    ).thread,
  );
  if (typeof thread.id !== "string") throw new Error("Codex did not return an ephemeral thread id");
  return thread.id;
}
