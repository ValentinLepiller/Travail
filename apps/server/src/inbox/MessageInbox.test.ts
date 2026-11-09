import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Inbox from "./MessageInbox.ts";

const gmail = {
  accountEmail: "me@example.com",
  id: "mail",
  threadId: "conversation",
  receivedAt: "1793278000.000001",
  sender: "Client <client@example.com>",
  subject: "Un échange",
  text: "Contenu complet\nAvec ses retours à la ligne",
};
const slack = {
  workspaceId: "TTEST",
  channelId: "CTEST",
  channelName: "projet",
  authorId: "UCLIENT",
  ts: "1793278000.000001",
  threadTs: "1793277990.000001",
  text: "Une réponse Slack",
};
const layer = Inbox.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "stores the full source and deduplicates each message independently of its conversation",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox;
      expect(yield* inbox.ingestGmail(gmail)).toBe("created");
      expect(yield* inbox.ingestSlack(slack)).toBe("created");
      expect(yield* inbox.ingestGmail({ ...gmail, text: "Changed remotely" })).toBe("duplicate");
      expect(yield* inbox.ingestSlack(slack)).toBe("duplicate");
      expect(yield* inbox.ingestGmail({ ...gmail, id: "mail2" })).toBe("created");
      expect(yield* inbox.ingestSlack({ ...slack, ts: "1793278001.000001" })).toBe("created");
      expect(yield* inbox.ingestGmail({ ...gmail, accountEmail: "other@example.com" })).toBe(
        "created",
      );
      expect(yield* inbox.ingestSlack({ ...slack, workspaceId: "TOTHER" })).toBe("created");
      const stored = yield* inbox.read({ id: "gmail:me@example.com:mail" });
      expect(stored.source).toEqual({ kind: "gmail", message: gmail });
      expect(stored.url).toContain("authuser=me%40example.com#all/mail");
      expect((yield* inbox.read({ id: "slack:TTEST:CTEST:1793278000.000001" })).source).toEqual({
        kind: "slack",
        message: slack,
      });
      expect((yield* inbox.list({})).messages).toHaveLength(6);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT id FROM work_tasks`).toEqual([]);
      expect((yield* inbox.read({ id: "missing" }).pipe(Effect.flip))._tag).toBe(
        "InboxMessageNotFound",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("pages without skipping entries when a new message arrives between reads", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MessageInbox;
    for (let n = 0; n < 22; n++) yield* inbox.ingestGmail({ ...gmail, id: `mail${n}` });
    const first = yield* inbox.list({});
    expect(first.messages).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    yield* inbox.ingestSlack(slack);
    const second = yield* inbox.list({ after: first.nextCursor! });
    expect(second.messages).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.messages, ...second.messages].map((m) => m.id)).size).toBe(23);
    expect((yield* inbox.list({ limit: 0 }).pipe(Effect.flip))._tag).toBe("InboxStorageError");
    expect((yield* inbox.list({ after: -1 }).pipe(Effect.flip))._tag).toBe("InboxStorageError");
  }).pipe(Effect.provide(layer)),
);

it.effect("retains messages and identities after closing and reopening an isolated database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "message-inbox-" });
    const db = Sqlite.layerFromPath(`${dir}/state.sqlite`);
    const isolated = Inbox.layer.pipe(Layer.provide(db));
    yield* Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox;
      yield* inbox.ingestGmail(gmail);
      yield* inbox.ingestSlack(slack);
    }).pipe(Effect.provide(isolated));
    yield* Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox;
      expect((yield* inbox.list({})).messages.map((m) => m.source.message)).toEqual([gmail, slack]);
      expect(yield* inbox.ingestGmail(gmail)).toBe("duplicate");
      expect(yield* inbox.ingestSlack(slack)).toBe("duplicate");
    }).pipe(Effect.provide(isolated));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
