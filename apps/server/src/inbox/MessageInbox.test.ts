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

it.effect("pages newest messages first without repeats when new messages arrive", () =>
  Effect.gen(function* () {
    const inbox = yield* Inbox.MessageInbox;
    const sql = yield* SqlClient.SqlClient;
    for (let n = 0; n < 13; n++) yield* inbox.ingestGmail({ ...gmail, id: `mail${n}` });
    yield* sql`DELETE FROM message_inbox WHERE sequence = 7`;
    const oldest = yield* inbox.list({});
    const expected = oldest.messages.map((m) => m.id).toReversed();
    const first = yield* inbox.list({ order: "desc", limit: 5 });
    expect(first.messages.map((m) => m.id)).toEqual(expected.slice(0, 5));
    expect(first.nextCursor).toBe(9);
    yield* inbox.ingestSlack(slack);
    const second = yield* inbox.list({ order: "desc", after: first.nextCursor!, limit: 5 });
    expect(second.messages.map((m) => m.id)).toEqual(expected.slice(5, 10));
    const last = yield* inbox.list({ order: "desc", after: second.nextCursor!, limit: 5 });
    expect(last.messages.map((m) => m.id)).toEqual(expected.slice(10));
    expect(last.nextCursor).toBeNull();
    expect((yield* inbox.list({ order: "desc", limit: 5 })).messages[0]?.source.kind).toBe("slack");
    expect((yield* inbox.list({ order: "desc", after: 0 })).messages).toEqual([]);
    expect((yield* inbox.list({ limit: 1 })).messages[0]?.id).toBe(expected.at(-1));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "filters processed messages before paging, including grouped entries and no_action only",
  () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.MessageInbox;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO inbox_subjects(id,title,summary,created_at,ignored) VALUES('ignored','Sujet','Résumé','',1)`;
      const processed: string[] = [],
        pending: string[] = [];
      for (let n = 0; n < 25; n++) {
        const id = `mail${n}`;
        yield* inbox.ingestGmail({ ...gmail, id });
        const entryId = `gmail:me@example.com:${id}`;
        if (n % 4 === 0) {
          yield* sql`INSERT INTO inbox_subject_entries(entry_id,subject_id,linked_at,decision_json) VALUES(${entryId},'ignored','','{}')`;
          processed.push(entryId);
        } else if (n % 4 === 1) {
          yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.qualification',json(${JSON.stringify({ version: 1, status: "qualified", category: "no_action", probabilities: { no_action: 1, information: 0, personal_action: 0, technical_action: 0, unsure: 0 }, confidence: 1, model: "test", qualifiedAt: "", usage: { input_tokens: 0, output_tokens: 0 } })})) WHERE id=${entryId}`;
          processed.push(entryId);
        } else pending.push(entryId);
      }
      for (const flag of [false, true]) {
        const expected = (flag ? processed : pending).toReversed();
        const seen: string[] = [];
        let after: number | undefined;
        do {
          const page = yield* inbox.list({
            processed: flag,
            order: "desc",
            limit: 5,
            ...(after === undefined ? {} : { after }),
          });
          seen.push(...page.messages.map((m) => m.id));
          expect(page.messages.length).toBeLessThanOrEqual(5);
          after = page.nextCursor ?? undefined;
        } while (after !== undefined);
        expect(seen).toEqual(expected);
      }
      expect((yield* inbox.list({ limit: 20 })).messages).toHaveLength(20);
      expect((yield* inbox.read({ id: processed[0]! })).id).toBe(processed[0]);
      const informational = "gmail:me@example.com:mail1";
      yield* sql`UPDATE message_inbox SET payload_json=json_set(payload_json,'$.qualification.category','information',
        '$.qualification.probabilities',json('{"no_action":0,"information":1,"personal_action":0,"technical_action":0,"unsure":0}')) WHERE id=${informational}`;
      expect((yield* inbox.list({ processed: false })).messages.map((m) => m.id)).toContain(
        informational,
      );
    }).pipe(Effect.provide(layer)),
);
