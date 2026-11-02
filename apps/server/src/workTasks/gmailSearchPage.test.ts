import { describe, expect, it } from "@effect/vitest";
import { parseGmailMessage, decodeGmailSearch } from "./gmailSearchPage.ts";
describe("Gmail source", () => {
  it("keeps sender, subject and plain MIME body for qualification", () => {
    expect(
      parseGmailMessage(
        {
          id: "abc",
          thread_id: "thread",
          internal_date: "1793278000123",
          payload: {
            headers: [
              { name: "From", value: "Client <client@example.com>" },
              { name: "Subject", value: "Demande" },
            ],
            mime_type: "multipart/alternative",
            parts: [
              { mime_type: "text/plain", body: { content: "Bonjour" }, parts: null },
              { mime_type: "text/html", body: { content: "<b>Bonjour</b>" } },
            ],
          },
        },
        "me@example.com",
      ),
    ).toMatchObject({
      sender: "Client <client@example.com>",
      subject: "Demande",
      text: "Bonjour\n",
      receivedAt: "1793278000.123000",
    });
  });
  it("accepts empty pages and refuses malformed timestamps", () => {
    expect(decodeGmailSearch({ message_ids: [] }).message_ids).toEqual([]);
    expect(() =>
      parseGmailMessage(
        { id: "a", thread_id: "b", internal_date: "bad", payload: { headers: [] } },
        "me@example.com",
      ),
    ).toThrow();
  });
});
