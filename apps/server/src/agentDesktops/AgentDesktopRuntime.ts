// @effect-diagnostics nodeBuiltinImport:off -- Native X11 subprocess adapter owns process groups and OS timers.
// @effect-diagnostics globalTimers:off -- Adapter deadlines/reaper are cleared on completion and disposal.
// @effect-diagnostics globalDate:off -- Native idle timestamps do not cross the Effect service boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";
import * as NodeTimers from "node:timers";

import {
  AgentDesktopError,
  isAgentDesktopError,
  isAgentDesktopLeaseId,
  type AgentDesktopApplication,
  type AgentDesktopController,
  type AgentDesktopInput,
  type AgentDesktopStatus,
  type AgentDesktopTarget,
} from "@t3tools/contracts";

export interface AgentDesktopConfiguration {
  readonly rootDirectory: string;
  readonly maxSessions?: number;
  readonly maxApplications?: number;
  readonly idleTimeoutMs?: number;
  readonly width?: number;
  readonly height?: number;
}

type Session = {
  id: string;
  ownerId: string;
  directory: string;
  runtimeDirectory: string;
  display: string;
  env: NodeJS.ProcessEnv;
  server: NodeChildProcess.ChildProcess;
  bus: NodeChildProcess.ChildProcess;
  applications: Set<NodeChildProcess.ChildProcess>;
  controller: AgentDesktopController;
  revision: number;
  lastUsed: number;
};

// Node's process boundary owns detached process groups; only captured groups are stopped.
async function stop(child: NodeChildProcess.ChildProcess) {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, value);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  };
  signal("SIGTERM");
  let deadline: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  await Promise.race([
    exit,
    new Promise<void>((resolve) => {
      deadline = NodeTimers.setTimeout(resolve, 750);
    }),
  ]);
  NodeTimers.clearTimeout(deadline);
  // Descendants can outlive the direct child. This group was created exclusively for us.
  signal("SIGKILL");
  await exit;
}

function execute(command: string, args: readonly string[], env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { env, encoding: "buffer", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (cause, stdout) => {
        if (cause) reject(cause);
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function spawnLimited(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  memoryMiB: number,
) {
  return NodeChildProcess.spawn(
    "prlimit",
    [
      `--as=${memoryMiB * 1024 * 1024}`,
      "--nofile=256",
      "--cpu=3600",
      "--",
      "setpriv",
      "--pdeathsig",
      "TERM",
      "--",
      command,
      ...args,
    ],
    { env, cwd: directory, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] },
  );
}

async function readyLine(child: NodeChildProcess.ChildProcess) {
  const pipe = child.stdio[3] as NodeStream.Readable;
  let value = "";
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error("Startup timed out")), 5_000);
    const data = (chunk: Buffer) => {
      value += chunk.toString();
      if (value.includes("\n")) finish();
    };
    const exited = () => finish(new Error("Process exited before ready"));
    const finish = (cause?: Error) => {
      globalThis.clearTimeout(timer);
      pipe.off("data", data);
      child.off("error", finish);
      child.off("exit", exited);
      if (cause) reject(cause);
      else resolve();
    };
    pipe.on("data", data);
    child.once("error", finish);
    child.once("exit", exited);
  });
  return value.trim();
}

function xauthority() {
  const field = (data: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length);
    return Buffer.concat([length, data]);
  };
  // FamilyWild lets Xvfb allocate its own unused display with -displayfd.
  return Buffer.concat([
    Buffer.from([255, 255]),
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(NodeCrypto.randomBytes(16)),
  ]);
}

export class AgentDesktopRuntime {
  readonly #sessions = new Map<string, Session>();
  readonly #config: Required<AgentDesktopConfiguration>;
  #queues = new Map<string, Promise<unknown>>();
  #opening = 0;
  readonly #pendingAcquisitions = new Map<string, number>();
  readonly #reaper: ReturnType<typeof NodeTimers.setInterval>;
  #disposed = false;

  constructor(configuration: AgentDesktopConfiguration) {
    this.#config = {
      maxSessions: 4,
      maxApplications: 4,
      idleTimeoutMs: 30 * 60_000,
      width: 1280,
      height: 800,
      ...configuration,
    };
    if (
      !NodePath.isAbsolute(configuration.rootDirectory) ||
      ![
        this.#config.maxSessions,
        this.#config.maxApplications,
        this.#config.idleTimeoutMs,
        this.#config.width,
        this.#config.height,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      this.#config.width > 1920 ||
      this.#config.height > 1080
    ) {
      throw new AgentDesktopError({ code: "invalid_input", operation: "configuration" });
    }
    this.#reaper = NodeTimers.setInterval(
      () => {
        void Promise.all(
          [...this.#sessions.values()].map((session) =>
            this.#serial(session.ownerId, "reap", async () => {
              if (
                this.#sessions.get(session.ownerId) === session &&
                session.controller === "agent" &&
                Date.now() - session.lastUsed >= this.#config.idleTimeoutMs
              )
                await this.#close(session);
            }),
          ),
        ).catch(() => undefined);
      },
      Math.min(this.#config.idleTimeoutMs, 60_000),
    );
    this.#reaper.unref();
  }

  #serial<A>(ownerId: string, operation: string, run: () => Promise<A>): Promise<A> {
    const result = (this.#queues.get(ownerId) ?? Promise.resolve()).then(async () => {
      try {
        if (this.#disposed) throw new AgentDesktopError({ code: "unavailable", operation });
        return await run();
      } catch (cause) {
        if (isAgentDesktopError(cause)) throw cause;
        throw new AgentDesktopError({ code: "operation_failed", operation, cause });
      }
    });
    const pending = result.catch(() => undefined);
    this.#queues.set(ownerId, pending);
    void pending.then(() => {
      if (this.#queues.get(ownerId) === pending) this.#queues.delete(ownerId);
    });
    return result;
  }

  #status(session: Session): AgentDesktopStatus {
    return {
      sessionId: session.id,
      ownerId: session.ownerId,
      display: session.display,
      width: this.#config.width,
      height: this.#config.height,
      controller: session.controller,
      revision: session.revision,
      applications: session.applications.size,
    };
  }

  #session(ownerId: string) {
    const session = this.#sessions.get(ownerId);
    if (
      !session ||
      session.server.exitCode !== null ||
      session.server.signalCode !== null ||
      session.bus.exitCode !== null ||
      session.bus.signalCode !== null
    )
      throw new AgentDesktopError({ code: "not_found", operation: "session" });
    session.lastUsed = Date.now();
    return session;
  }

  #controlled(session: Session, actor: AgentDesktopController, target: AgentDesktopTarget) {
    if (
      session.controller !== actor ||
      session.revision !== target.revision ||
      session.id !== target.sessionId
    )
      throw new AgentDesktopError({ code: "control_conflict", operation: "control" });
  }

  async acquire(namespace: string, leaseId: string = NodeCrypto.randomUUID()) {
    if (!isAgentDesktopLeaseId(leaseId))
      throw new AgentDesktopError({ code: "invalid_input", operation: "lease" });
    return { leaseId, status: await this.ensure(`${namespace}/${leaseId}`) };
  }

  list(namespace: string) {
    return this.#serial(namespace, "list", async () =>
      [...this.#sessions.values()]
        .filter(
          (session) =>
            session.ownerId.startsWith(`${namespace}/`) &&
            session.server.exitCode === null &&
            session.server.signalCode === null,
        )
        .map((session) => ({
          leaseId: session.ownerId.slice(namespace.length + 1),
          status: this.#status(session),
        })),
    );
  }

  activeCount() {
    return new Set([...this.#sessions.keys(), ...this.#pendingAcquisitions.keys()]).size;
  }

  ensure(ownerId: string) {
    this.#pendingAcquisitions.set(ownerId, (this.#pendingAcquisitions.get(ownerId) ?? 0) + 1);
    return this.#serial(ownerId, "open", async () => {
      if (!ownerId.trim() || ownerId.length > 256)
        throw new AgentDesktopError({ code: "invalid_input", operation: "owner" });
      const previous = this.#sessions.get(ownerId);
      if (previous) {
        if (
          previous.server.exitCode === null &&
          previous.server.signalCode === null &&
          previous.bus.exitCode === null &&
          previous.bus.signalCode === null
        )
          return this.#status(this.#session(ownerId));
        await this.#close(previous);
      }
      if (this.#sessions.size + this.#opening >= this.#config.maxSessions)
        throw new AgentDesktopError({ code: "capacity", operation: "open" });
      const id = NodeCrypto.randomUUID();
      const profileId = NodeCrypto.createHash("sha256").update(ownerId).digest("hex");
      const directory = NodePath.join(this.#config.rootDirectory, profileId);
      this.#opening++;
      let runtimeDirectory: string | undefined;
      try {
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        await NodeFSP.chmod(directory, 0o700);
        const home = NodePath.join(directory, "home");
        const runtime = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mt-agent-desktop-"));
        runtimeDirectory = runtime;
        for (const path of [
          home,
          runtime,
          NodePath.join(home, ".config"),
          NodePath.join(home, ".cache"),
          NodePath.join(home, ".local/share"),
        ])
          await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
        const auth = NodePath.join(runtime, "Xauthority");
        await NodeFSP.writeFile(auth, xauthority(), { mode: 0o600 });
        // Do not carry the user's Wayland display, D-Bus, portals, keyring or app profiles.
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "C.UTF-8",
          TZ: process.env.TZ,
          HOME: home,
          XDG_CONFIG_HOME: NodePath.join(home, ".config"),
          XDG_CACHE_HOME: NodePath.join(home, ".cache"),
          XDG_DATA_HOME: NodePath.join(home, ".local/share"),
          XDG_RUNTIME_DIR: runtime,
          XAUTHORITY: auth,
          QT_QPA_PLATFORM: "xcb",
          GDK_BACKEND: "x11",
          NO_AT_BRIDGE: "1",
        };
        const server = spawnLimited(
          "Xvfb",
          [
            "-displayfd",
            "3",
            "-screen",
            "0",
            `${this.#config.width}x${this.#config.height}x24`,
            "-nolisten",
            "tcp",
            "-auth",
            auth,
          ],
          env,
          directory,
          512,
        );
        let bus: NodeChildProcess.ChildProcess | undefined;
        try {
          const display = await readyLine(server);
          if (!/^\d+$/.test(display)) throw new Error("Invalid display");
          env.DISPLAY = `:${display}`;
          bus = spawnLimited(
            "dbus-daemon",
            [
              "--session",
              "--nofork",
              "--print-address=3",
              `--address=unix:path=${NodePath.join(runtime, "bus")}`,
            ],
            env,
            directory,
            128,
          );
          env.DBUS_SESSION_BUS_ADDRESS = await readyLine(bus);
          const session: Session = {
            id,
            ownerId,
            directory,
            runtimeDirectory: runtime,
            display: env.DISPLAY,
            env,
            server,
            bus,
            applications: new Set(),
            controller: "agent",
            revision: 0,
            lastUsed: Date.now(),
          };
          await NodeFSP.writeFile(
            NodePath.join(directory, "session.json"),
            JSON.stringify({
              serverPid: server.pid,
              busPid: bus.pid,
              display: session.display,
              runtimeDirectory: runtime,
              busAddress: env.DBUS_SESSION_BUS_ADDRESS,
            }),
            { mode: 0o600 },
          );
          this.#sessions.set(ownerId, session);
          return this.#status(session);
        } catch (cause) {
          if (bus) await stop(bus);
          await stop(server);
          throw cause;
        }
      } finally {
        this.#opening--;
        if (!this.#sessions.has(ownerId) && runtimeDirectory)
          await NodeFSP.rm(runtimeDirectory, { recursive: true, force: true });
      }
    }).finally(() => {
      const remaining = (this.#pendingAcquisitions.get(ownerId) ?? 1) - 1;
      if (remaining === 0) this.#pendingAcquisitions.delete(ownerId);
      else this.#pendingAcquisitions.set(ownerId, remaining);
    });
  }

  status(ownerId: string) {
    return this.#serial(ownerId, "status", async () => this.#status(this.#session(ownerId)));
  }

  launch(
    ownerId: string,
    application: AgentDesktopApplication,
    target: AgentDesktopTarget,
    message = "Agent desktop",
  ) {
    return this.#serial(ownerId, "launch", async () => {
      const session = this.#session(ownerId);
      this.#controlled(session, "agent", target);
      if (session.applications.size >= this.#config.maxApplications)
        throw new AgentDesktopError({ code: "capacity", operation: "launch" });
      if (message.length > 4096 || !["message", "terminal"].includes(application))
        throw new AgentDesktopError({ code: "invalid_input", operation: "launch" });
      const child =
        application === "message"
          ? spawnLimited(
              "xmessage",
              [
                "-title",
                `MT Agent ${session.id}`,
                "-geometry",
                "640x400+20+20",
                "-buttons",
                "OK:0",
                "--",
                message,
              ],
              session.env,
              session.directory,
              512,
            )
          : spawnLimited(
              "konsole",
              [
                "--separate",
                "--nofork",
                "--workdir",
                session.env.HOME!,
                "-e",
                "/bin/bash",
                "--noprofile",
                "--norc",
              ],
              session.env,
              session.directory,
              2048,
            );
      session.applications.add(child);
      child.once("exit", () => session.applications.delete(child));
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        await execute(
          "xdotool",
          application === "message"
            ? ["search", "--sync", "--onlyvisible", "--name", `^MT Agent ${session.id}$`]
            : ["search", "--sync", "--onlyvisible", "--pid", String(child.pid)],
          session.env,
        );
        return this.#status(session);
      } catch (cause) {
        session.applications.delete(child);
        await stop(child);
        throw cause;
      }
    });
  }

  async #windows(session: Session) {
    let ids: Buffer;
    try {
      ids = await execute("xdotool", ["search", "--onlyvisible", "--name", "."], session.env);
    } catch (cause) {
      if ((cause as { code?: number }).code === 1) return [];
      throw cause;
    }
    return Promise.all(
      ids
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 64)
        .map(async (id) => ({
          id,
          title: (await execute("xdotool", ["getwindowname", id], session.env)).toString().trim(),
        })),
    );
  }

  capture(ownerId: string) {
    return this.#serial(ownerId, "capture", async () => {
      const session = this.#session(ownerId);
      const image = await execute("import", ["-window", "root", "png:-"], session.env);
      return {
        status: this.#status(session),
        windows: await this.#windows(session),
        screenshot: {
          mimeType: "image/png" as const,
          data: image.toString("base64"),
          width: this.#config.width,
          height: this.#config.height,
        },
      };
    });
  }

  input(ownerId: string, actor: AgentDesktopController, input: AgentDesktopInput) {
    return this.#serial(ownerId, "input", async () => {
      const session = this.#session(ownerId);
      this.#controlled(session, actor, input);
      if (
        !/^\d+$/.test(input.windowId) ||
        !(await this.#windows(session)).some((window) => window.id === input.windowId)
      )
        throw new AgentDesktopError({ code: "invalid_input", operation: "window" });
      const args = ["windowfocus", "--sync", input.windowId];
      let typedText: string | undefined;
      switch (input.kind) {
        case "click":
          if (
            ![input.x, input.y].every(Number.isSafeInteger) ||
            input.x < 0 ||
            input.y < 0 ||
            input.x >= this.#config.width ||
            input.y >= this.#config.height
          )
            throw new AgentDesktopError({ code: "invalid_input", operation: "coordinates" });
          args.push(
            "mousemove",
            "--sync",
            String(input.x),
            String(input.y),
            "click",
            String(input.button ?? 1),
          );
          break;
        case "type":
          if (input.text.length > 4096)
            throw new AgentDesktopError({ code: "invalid_input", operation: "text" });
          args.push("type", "--clearmodifiers", "--delay", "1", "--file", "-");
          typedText = input.text;
          break;
        case "key":
          if (!/^[A-Za-z0-9_+]+$/.test(input.key) || input.key.length > 128)
            throw new AgentDesktopError({ code: "invalid_input", operation: "key" });
          args.push("key", "--clearmodifiers", "--", input.key);
          break;
      }
      await execute("xdotool", args, session.env, typedText);
      return this.#status(session);
    });
  }

  transfer(ownerId: string, target: AgentDesktopTarget, controller: AgentDesktopController) {
    return this.#serial(ownerId, "transfer", async () => {
      const session = this.#session(ownerId);
      if (!["agent", "human"].includes(controller))
        throw new AgentDesktopError({ code: "invalid_input", operation: "controller" });
      if (session.revision !== target.revision || session.id !== target.sessionId)
        throw new AgentDesktopError({ code: "control_conflict", operation: "transfer" });
      session.controller = controller;
      session.revision++;
      return this.#status(session);
    });
  }

  async #close(session: Session) {
    const results = await Promise.allSettled(
      [...session.applications, session.bus, session.server].map(stop),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        "Desktop cleanup failed",
      );
    await NodeFSP.rm(NodePath.join(session.directory, "session.json"), { force: true });
    // A hashed owner directory preserves the profile on close/reopen and server restart.
    await NodeFSP.rm(session.runtimeDirectory, { recursive: true, force: true });
    this.#sessions.delete(session.ownerId);
  }

  close(ownerId: string, actor: AgentDesktopController = "agent", target?: AgentDesktopTarget) {
    return this.#serial(ownerId, "close", async () => {
      const session = this.#sessions.get(ownerId);
      if (!session) throw new AgentDesktopError({ code: "not_found", operation: "close" });
      this.#controlled(session, actor, target ?? this.#status(session));
      await this.#close(session);
    });
  }

  async dispose() {
    NodeTimers.clearInterval(this.#reaper);
    this.#disposed = true;
    await Promise.all(this.#queues.values());
    const results = await Promise.allSettled(
      [...this.#sessions.values()].map((session) => this.#close(session)),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        "Desktop shutdown failed",
      );
  }
}
