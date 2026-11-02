import { expect, it, vi } from "vite-plus/test";
import { callConnector, prepareCall } from "./adapter.ts";

it("preserves explicit search limits and defaults Gmail reading to metadata", () => {
  expect(
    prepareCall({ operation: "gmail.search", arguments: { query: "in:inbox", max_results: 10 } })
      .arguments,
  ).toEqual({ query: "in:inbox", max_results: 10 });
  expect(
    prepareCall({ operation: "gmail.read", arguments: { message_id: "fixture" } }).arguments.format,
  ).toBe("metadata");
  expect(
    prepareCall({
      operation: "slack.search",
      arguments: { keywords: ["fixture"], limit: 20, include_context: true },
    }).arguments,
  ).toEqual({
    keywords: ["fixture"],
    limit: 20,
    include_context: true,
    response_format: "concise",
  });
});

it("allows read-only search across private channels and DMs without changing its bounds", () => {
  const call = prepareCall({
    operation: "slack.searchAll",
    arguments: {
      filters: "-from:me",
      after: "1793278000.000000",
      before: "1793278060.000000",
      response_format: "detailed",
      sort: "timestamp",
      sort_dir: "asc",
      cursor: "next",
      limit: 20,
    },
  });
  expect(call.tool).toBe("slack.slack_search_public_and_private");
  expect(call.arguments).toMatchObject({
    after: "1793278000.000000",
    before: "1793278060.000000",
    cursor: "next",
    include_context: false,
    response_format: "detailed",
  });
});

it.each([
  "gmail.createDraft",
  "gmail.updateDraft",
  "gmail.sendDraft",
  "gmail.send",
  "slack.createDraft",
  "slack.send",
])("blocks %s without explicit write acknowledgment before transport", async (operation) => {
  const rpc = vi.fn();
  await expect(callConnector(rpc, "fixture-thread", { operation, arguments: {} })).rejects.toThrow(
    "Writing requires",
  );
  await expect(
    callConnector(rpc, "fixture-thread", { operation, arguments: {} }, true),
  ).rejects.toThrow("Writing requires");
  expect(rpc).not.toHaveBeenCalled();
});

it("passes an editable HTML Gmail draft and exact destination to the native connector", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValue({ isError: false, structuredContent: { id: "fixture-draft" } });
  const args = {
    to: "fixture@example.invalid",
    subject: "Fixture",
    payload: {
      mime_type: "text/html",
      charset: "UTF-8",
      body: { content: "<p>Editable fixture</p>" },
    },
  };
  const result = await callConnector(
    rpc,
    "fixture-thread",
    {
      operation: "gmail.createDraft",
      authorization: "Create this draft for fixture@example.invalid",
      arguments: args,
    },
    true,
  );
  expect(rpc).toHaveBeenCalledWith("mcpServer/tool/call", {
    threadId: "fixture-thread",
    server: "codex_apps",
    tool: "gmail.create_draft",
    arguments: args,
  });
  expect(result.structuredContent).toEqual({ id: "fixture-draft" });
});

it("preserves sparse draft updates and supports explicit plain-text requests", () => {
  expect(
    prepareCall(
      {
        operation: "gmail.updateDraft",
        authorization: "Change its subject",
        arguments: { draft_id: "fixture", subject: "Revised" },
      },
      true,
    ).arguments,
  ).toEqual({ draft_id: "fixture", subject: "Revised" });
  const request = {
    operation: "gmail.createDraft",
    authorization: "Create plain text draft",
    arguments: { payload: { mime_type: "text/plain", body: { content: "Fixture" } } },
  };
  expect(() => prepareCall(request, true)).toThrow("text/html");
  expect(prepareCall({ ...request, plainTextRequested: true }, true).arguments.payload).toEqual(
    request.arguments.payload,
  );
});

it.each([
  ["gmail.sendDraft", { draft_id: "fixture-draft" }, "gmail.send_draft"],
  [
    "slack.createDraft",
    { channel_id: "C_FIXTURE", message: "Fixture" },
    "slack.slack_send_message_draft",
  ],
  ["slack.send", { channel_id: "C_FIXTURE", message: "Fixture" }, "slack.slack_send_message"],
])("routes authorized %s with fixtures only", async (operation, args, tool) => {
  const rpc = vi.fn().mockResolvedValue({ structuredContent: { ok: true } });
  await callConnector(
    rpc,
    "fixture-thread",
    { operation, arguments: args, authorization: "Human explicitly requested this fixture action" },
    true,
  );
  expect(rpc).toHaveBeenCalledWith("mcpServer/tool/call", {
    threadId: "fixture-thread",
    server: "codex_apps",
    tool,
    arguments: args,
  });
});

it("does not turn connector errors or missing integrations into success", async () => {
  await expect(
    callConnector(vi.fn().mockResolvedValue({ isError: true }), "fixture", {
      operation: "gmail.profile",
    }),
  ).rejects.toThrow("Connector tool failed");
  expect(() => prepareCall({ operation: "teams.read" })).toThrow("not connected");
  expect(() => prepareCall({ operation: "whatsapp.send" }, true)).toThrow("not connected");
});

it("rejects invalid page limits instead of silently reducing requested results", () => {
  for (const limit of [0, 21, 1.5, "10"]) {
    expect(() =>
      prepareCall({ operation: "gmail.search", arguments: { max_results: limit } }),
    ).toThrow("between 1 and 20");
  }
  expect(
    prepareCall({
      operation: "slack.channels",
      arguments: { limit: 10, types: "private_channel", response_format: "names_only" },
    }).arguments,
  ).toEqual({ limit: 10, types: "private_channel", response_format: "names_only" });
});

it("preserves null sparse payload and rejects HTML attachments as a substitute for an HTML body", () => {
  const base = {
    operation: "gmail.updateDraft",
    authorization: "Change the draft subject",
    arguments: { draft_id: "fixture", subject: "Revised", payload: null },
  };
  expect(prepareCall(base, true).arguments.payload).toBeNull();
  const mime = {
    mime_type: "multipart/mixed",
    parts: [
      { mime_type: "text/plain", body: { content: "Plain body" } },
      {
        mime_type: "text/html",
        content_disposition: "attachment",
        filename: "fixture.html",
        body: { content: "<p>Attachment</p>" },
      },
    ],
  };
  expect(() =>
    prepareCall({ ...base, arguments: { draft_id: "fixture", payload: mime } }, true),
  ).toThrow("text/html");
  mime.parts[0] = { mime_type: "text/html", body: { content: "<p>Editable body</p>" } };
  expect(
    prepareCall({ ...base, arguments: { draft_id: "fixture", payload: mime } }, true).arguments
      .payload,
  ).toEqual(mime);
});

const accountStatus = (ids: string[]) => ({
  data: [
    {
      name: "codex_apps",
      tools: {
        "gmail.search_email_ids": {
          inputSchema: {
            required: ["link_id"],
            properties: {
              link_id: {
                description: `Accounts:\n${JSON.stringify(
                  ids.map((link_id) => ({ link_id })),
                  null,
                  2,
                )}`,
              },
            },
          },
        },
      },
    },
  ],
});

it("uses the sole published account and keeps explicit account selection", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce(accountStatus(["account-a"]))
    .mockResolvedValue({ isError: false });
  await callConnector(rpc, "thread", { operation: "gmail.search", arguments: {} });
  expect(rpc).toHaveBeenLastCalledWith(
    "mcpServer/tool/call",
    expect.objectContaining({ arguments: { max_results: 5, link_id: "account-a" } }),
  );
  rpc.mockClear();
  await callConnector(rpc, "thread", {
    operation: "gmail.search",
    arguments: { link_id: "account-b" },
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenLastCalledWith(
    "mcpServer/tool/call",
    expect.objectContaining({ arguments: { max_results: 5, link_id: "account-b" } }),
  );
});

it("requires account selection when multiple accounts are published", async () => {
  const rpc = vi.fn().mockResolvedValue(accountStatus(["account-a", "account-b"]));
  await expect(
    callConnector(rpc, "thread", { operation: "gmail.search", arguments: {} }),
  ).rejects.toThrow("Choose the account");
  expect(rpc).toHaveBeenCalledTimes(1);
});
