import { PassThrough } from "node:stream";
import {
  channels,
  formatSseEvent,
  SSE_HEARTBEAT_MS,
  SSE_PRESENCE_REFRESH_MS,
  type SseEvent,
  sseEventSchema,
} from "@codesh/shared";
import type { Ctx } from "../ctx.js";
import {
  listNearbyCached,
  listPresence,
  publishPresence,
  removePresence,
  touchPresence,
} from "../presence.js";
import type { App } from "./types.js";

const MAX_BUFFERED_BYTES = 1024 * 1024;

/** `GET /api/events` (§9.1): per-user and per-network-group events over one SSE stream. */
export function eventRoutes(app: App, ctx: Ctx): void {
  const heartbeatMs = ctx.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const refreshMs = ctx.presenceRefreshMs ?? SSE_PRESENCE_REFRESH_MS;

  app.get("/api/events", async (request, reply) => {
    const { session } = request;
    const { clientId, net } = session;
    // A stream payload (not a hijacked socket) keeps Fastify's onSend hooks, which is where the
    // cookie of a first-time visitor is written.
    const stream = new PassThrough();
    const lastSent = new Map<string, string>();
    const timers: NodeJS.Timeout[] = [];
    const unsubscribers: (() => void)[] = [];
    let closed = false;
    let counted = false;

    const close = () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      for (const off of unsubscribers) off();
      ctx.streamClosers.delete(close);
      if (counted) {
        ctx.metrics.sseConnections.dec();
        const left = (ctx.streams.get(clientId) ?? 1) - 1;
        if (left > 0) {
          ctx.streams.set(clientId, left);
        } else {
          ctx.streams.delete(clientId);
          // Last tab closed: leave the lists now instead of lingering for a minute.
          void removePresence(ctx, session)
            .then(() => publishPresence(ctx, net))
            .catch(() => undefined);
        }
      }
      stream.end();
    };
    // Registered first, so closing the server ends the stream however far the setup got.
    ctx.streamClosers.add(close);
    request.raw.on("close", close);

    const send = (event: SseEvent) => {
      if (closed) return;
      // A client that stopped reading must not make the server hold its events in memory.
      if (stream.writableLength > MAX_BUFFERED_BYTES) return close();
      stream.write(formatSseEvent(event));
    };
    // Lists are pushed again only when they changed.
    const sendList = (event: Extract<SseEvent, { event: "presence" | "nearby" }>) => {
      const body = JSON.stringify(event.data);
      if (lastSent.get(event.event) === body) return;
      lastSent.set(event.event, body);
      send(event);
    };
    const presenceList = async () =>
      (await listPresence(ctx, net)).filter((user) => user.clientId !== clientId);

    const onMessage = (message: string) => {
      let parsed: ReturnType<typeof sseEventSchema.safeParse>;
      try {
        parsed = sseEventSchema.safeParse(JSON.parse(message));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const event = parsed.data as SseEvent;
      if (event.event === "presence") {
        sendList({
          event: "presence",
          data: event.data.filter((user) => user.clientId !== clientId),
        });
      } else if (event.event === "nearby") {
        sendList(event);
      } else {
        send(event);
      }
    };

    reply
      .header("Content-Type", "text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("X-Accel-Buffering", "no");
    stream.write("retry: 3000\n\n");

    for (const channel of [channels.user(clientId), channels.net(net)]) {
      const off = await ctx.hub.subscribe(channel, onMessage);
      if (closed) off();
      else unsubscribers.push(off);
    }
    if (closed) return reply.send(stream);

    counted = true;
    ctx.streams.set(clientId, (ctx.streams.get(clientId) ?? 0) + 1);
    ctx.metrics.sseConnections.inc();
    timers.push(
      setInterval(() => {
        if (!closed) stream.write(": heartbeat\n\n");
      }, heartbeatMs),
      setInterval(() => {
        void (async () => {
          try {
            await touchPresence(ctx, session);
            sendList({ event: "presence", data: await presenceList() });
            sendList({ event: "nearby", data: await listNearbyCached(ctx, net) });
          } catch (error) {
            request.log.warn({ err: error }, "sse refresh failed");
          }
        })();
      }, refreshMs),
    );

    await touchPresence(ctx, session);
    sendList({ event: "presence", data: await presenceList() });
    sendList({ event: "nearby", data: await listNearbyCached(ctx, net) });
    await publishPresence(ctx, net);
    return reply.send(stream);
  });
}
