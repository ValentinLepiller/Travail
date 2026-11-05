import { AgentRequestSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { gmailMessageUrl } from "../workTasks/gmailTaskRules.ts";

const decodeSource = Schema.decodeUnknownOption(AgentRequestSource);

export const requestSources = Effect.fn("AgentRequestService.sources")(function* (
  requestId: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  // A batch's first task is not necessarily the subject of a particular request.
  const rows = yield* sql<{
    id: string;
    kind: string | null;
    label: string | null;
    url: string | null;
    text: string | null;
    author: string;
    title: string;
    account_email: string | null;
    message_id: string | null;
  }>`WITH origins AS (
    SELECT q.id, COALESCE(json_extract(q.payload_json, '$.sourceTaskId'),
      CASE WHEN json_array_length(r.task_ids_json) <= 1 THEN r.task_id END,
      (SELECT MIN(t.id) FROM work_tasks t
        WHERE json_extract(t.payload_json, '$.agentThreadId') = json_extract(q.payload_json, '$.threadId')
        HAVING COUNT(*) = 1)) AS task_id
    FROM agent_requests q
    LEFT JOIN autonomous_agent_runs r ON r.thread_id = json_extract(q.payload_json, '$.threadId')
    WHERE (${requestId} IS NULL OR q.id = ${requestId})
      AND json_type(q.payload_json, '$.source') IS NULL
  ) SELECT o.id,
    CASE WHEN s.message_ts IS NOT NULL THEN 'slack' WHEN g.message_id IS NOT NULL THEN 'email'
      WHEN json_array_length(t.payload_json, '$.sources') = 1 THEN json_extract(t.payload_json, '$.sources[0].kind') END AS kind,
    CASE WHEN s.message_ts IS NOT NULL THEN COALESCE(NULLIF(json_extract(s.payload_json, '$.channelName'), ''), 'Slack')
      WHEN g.message_id IS NOT NULL THEN 'Gmail'
      ELSE json_extract(t.payload_json, '$.sources[0].label') END AS label,
    CASE WHEN s.message_ts IS NOT NULL THEN 'https://app.slack.com/archives/' || s.channel_id || '/p' || replace(s.message_ts, '.', '')
      WHEN g.message_id IS NOT NULL THEN NULL
      ELSE json_extract(t.payload_json, '$.sources[0].url') END AS url,
    substr(CASE WHEN s.message_ts IS NOT NULL THEN json_extract(s.payload_json, '$.text')
      WHEN g.message_id IS NOT NULL THEN json_extract(g.payload_json, '$.text') END, 1, 6000) AS text,
    substr(COALESCE(json_extract(s.payload_json, '$.authorId'), json_extract(g.payload_json, '$.sender'), ''), 1, 500) AS author,
    substr(COALESCE(json_extract(g.payload_json, '$.subject'), ''), 1, 500) AS title,
    g.account_email, g.message_id
  FROM origins o
  LEFT JOIN work_tasks t ON t.id = o.task_id
  LEFT JOIN work_task_slack_messages s ON 'slack:' || s.workspace_id || ':' || s.channel_id || ':' || s.message_ts = o.task_id
  LEFT JOIN work_task_gmail_messages g ON 'gmail:' || g.account_email || ':' || g.message_id = o.task_id`;
  const sources = new Map<string, typeof AgentRequestSource.Type>();
  for (const row of rows) {
    const source = decodeSource({
      ...row,
      label: row.label?.slice(0, 240),
      text: row.text?.slice(0, 6000) ?? null,
      author: row.author.slice(0, 500),
      title: row.title.slice(0, 500),
      url:
        row.account_email && row.message_id
          ? gmailMessageUrl(row.account_email, row.message_id)
          : row.url,
    });
    if (Option.isSome(source)) sources.set(row.id, source.value);
  }
  return sources;
});
