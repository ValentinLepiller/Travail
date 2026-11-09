import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Runner from "../processRunner.ts";
import * as Source from "./InboxContextSource.ts";
const target = {
  kind: "gmail" as const,
  message: {
    accountEmail: "me@example.com",
    id: "mail",
    threadId: "thread",
    receivedAt: "1793975405.000001",
    sender: "Client",
    subject: "Fil",
    text: "Principal",
  },
};
const rules = {
  enabled: true,
  accountEmail: "me@example.com",
  excludeSenders: [],
  excludeText: [],
  collector: {
    executable: "node",
    args: ["old-main-collector.ts"],
    cwd: "/tmp",
    codexHome: "/tmp/profile",
    linkId: "existing-account",
  },
};
it.effect(
  "uses the configured account/profile for context and refuses another account before calling a process",
  () => {
    const calls: Runner.ProcessRunInput[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        config = yield* Config.ServerConfig,
        source = yield* Source.InboxContextSource;
      yield* fs.writeFileString(config.stateDir + "/gmail-task-rules.json", JSON.stringify(rules));
      expect(yield* source.read(target)).toMatchObject({ status: "ready", messages: [] });
      expect(calls[0]?.args?.[0]).toMatch(/collect-inbox-context\.ts$/);
      expect(calls[0]?.env?.CODEX_HOME).toBe("/tmp/profile");
      expect(JSON.parse(calls[0]!.stdin!)).toEqual({ source: target, linkId: "existing-account" });
      expect(
        (yield* source
          .read({ ...target, message: { ...target.message, accountEmail: "other@example.com" } })
          .pipe(Effect.flip)).reason,
      ).toBe("configuration");
      expect(calls).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Source.layer.pipe(
          Layer.provide(
            Layer.succeed(Runner.ProcessRunner, {
              run: (input) => {
                calls.push(input);
                return Effect.succeed({
                  code: ChildProcessSpawner.ExitCode(0),
                  stdout: '{"status":"ready","messages":[],"truncated":false,"reason":null}',
                  stderr: "",
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                });
              },
            }),
          ),
          Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "context-source-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);
