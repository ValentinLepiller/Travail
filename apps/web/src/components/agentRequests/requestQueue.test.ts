import { describe, expect, it } from "vite-plus/test";
import { requestQueue } from "./requestQueue";

describe("request inbox", () => {
  it("opens the oldest waiting request and advances when the current one is answered", () => {
    const first = { id: "first", status: "pending" as const };
    const second = { id: "second", status: "pending" as const };
    expect(requestQueue([first, second], false, null).current?.id).toBe("first");
    const answered = { ...first, status: "accepted" as const };
    const queue = requestQueue([answered, second], false, first.id);
    expect(queue.current?.id).toBe("second");
    expect(queue.pendingCount).toBe(1);
    expect(queue.visible).toEqual([second]);
    expect(requestQueue([answered, second], true, null).visible).toEqual([answered]);
  });
  it("archives ignored requests and advances to the next waiting request", () => {
    const ignored = { id: "first", status: "ignored" as const };
    const pending = { id: "second", status: "pending" as const };
    const queue = requestQueue([ignored, pending], false, ignored.id);
    expect(queue.current).toEqual(pending);
    expect(queue.pendingCount).toBe(1);
    expect(queue.visible).toEqual([pending]);
    expect(requestQueue([ignored, pending], true, null).current).toEqual(ignored);
  });
  it("keeps a selected request until it leaves the queue and hides requests awaiting revision", () => {
    const requests = [
      { id: "first", status: "pending" as const },
      { id: "second", status: "pending" as const },
    ];
    expect(requestQueue(requests, false, "second").current?.id).toBe("second");
    const revision = { id: "second", status: "revision" as const };
    expect(requestQueue([requests[0]!, revision], false, "second").current?.id).toBe("first");
    expect(requestQueue([revision], true, null).current).toEqual(revision);
    expect(requestQueue([], false, null).current).toBeUndefined();
  });
});
