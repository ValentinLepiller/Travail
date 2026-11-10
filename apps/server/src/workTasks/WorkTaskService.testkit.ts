import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { SlackTaskMessage } from "@t3tools/contracts";
import { GmailTaskMessage } from "./gmailTaskRules.ts";
import * as Tasks from "./WorkTaskService.ts";

export const taskImageTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-task-images-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const encodeSlack = Schema.encodeEffect(Schema.fromJsonString(SlackTaskMessage));
const encodeGmail = Schema.encodeEffect(Schema.fromJsonString(GmailTaskMessage));

export const seedLegacySlackTask = (message: SlackTaskMessage) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.WorkTaskService;
    const sql = yield* SqlClient.SqlClient;
    const id = `slack:${message.workspaceId}:${message.channelId}:${message.ts}`;
    yield* tasks.save({
      id,
      expectedVersion: 0,
      title: "Historical Slack task",
      notes: "",
      status: "ready",
      projectId: null,
      agentThreadId: null,
      dueDate: null,
    });
    yield* sql`INSERT INTO work_task_slack_messages(workspace_id,channel_id,message_ts,thread_ts,task_id,payload_json)
    VALUES(${message.workspaceId},${message.channelId},${message.ts},${message.threadTs},${id},${yield* encodeSlack(message)})`;
  });

export const seedLegacyGmailTask = (message: GmailTaskMessage) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.WorkTaskService;
    const sql = yield* SqlClient.SqlClient;
    const id = `gmail:${message.accountEmail}:${message.id}`;
    yield* tasks.save({
      id,
      expectedVersion: 0,
      title: message.subject || "Historical Gmail task",
      notes: "",
      status: "ready",
      projectId: null,
      agentThreadId: null,
      dueDate: null,
    });
    yield* sql`INSERT INTO work_task_gmail_messages(account_email,message_id,task_id,payload_json)
    VALUES(${message.accountEmail},${message.id},${id},${yield* encodeGmail(message)})`;
  });
