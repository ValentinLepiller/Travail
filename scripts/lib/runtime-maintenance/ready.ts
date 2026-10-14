// @effect-diagnostics globalFetch:off globalTimers:off nodeBuiltinImport:off - Independent readiness probe; temporary bearer never enters logs.
import { withProbeSession } from "./auth.ts";
import type { RuntimeConfig } from "./config.ts";

export async function awaitReady(config: RuntimeConfig, updateId?: string) {
  const origin = `http://127.0.0.1:${config.port}`;
  return withProbeSession(config, "orchestration:read", async (token) => {
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!ticketResponse.ok) throw new Error("Cannot authenticate readiness probe");
    const ticket = (await ticketResponse.json()) as { ticket: string };
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${config.port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      );
      const timer = setTimeout(
        () => settle(new Error("MT did not publish the matching ready event")),
        15_000,
      );
      let done = false;
      function settle(error?: Error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve();
      }
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "subscribeServerLifecycle",
            payload: {},
            headers: [],
          }),
        ),
      );
      socket.addEventListener("error", () => settle(new Error("Readiness socket failed")));
      socket.addEventListener("close", () => {
        if (!done) settle(new Error("Host closed before ready"));
      });
      socket.addEventListener("message", (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as {
            _tag: string;
            values?: {
              type?: string;
              payload?: {
                environment?: { environmentId?: string };
                updateOutcome?: { id?: string; status?: string };
              };
            }[];
          };
          if (frame._tag === "Ping") {
            socket.send(JSON.stringify({ _tag: "Pong" }));
            return;
          }
          if (frame._tag !== "Chunk") return;
          for (const event of frame.values ?? []) {
            if (
              event.type === "ready" &&
              event.payload?.environment?.environmentId === config.environmentId &&
              (updateId === undefined ||
                (event.payload.updateOutcome?.id === updateId &&
                  event.payload.updateOutcome.status === "committed"))
            ) {
              settle();
              return;
            }
          }
          socket.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
        } catch {
          settle(new Error("Invalid lifecycle frame"));
        }
      });
    });
  });
}
