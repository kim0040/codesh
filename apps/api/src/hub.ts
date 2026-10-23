import type { Redis } from "ioredis";

type Handler = (message: string) => void;

/**
 * Fan-out of Valkey pub/sub messages to in-process listeners over one subscriber connection.
 * A channel is subscribed while it has at least one listener.
 */
export class Hub {
  private readonly channels = new Map<
    string,
    { handlers: Set<Handler>; ready: Promise<unknown> }
  >();

  constructor(private readonly subscriber: Redis) {
    subscriber.on("message", (channel: string, message: string) => {
      for (const handler of this.channels.get(channel)?.handlers ?? []) {
        try {
          handler(message);
        } catch {
          // A broken listener must not stop delivery to the others.
        }
      }
    });
  }

  /** Resolves once Valkey has confirmed the subscription, so a later publish cannot be missed. */
  async subscribe(channel: string, handler: Handler): Promise<() => void> {
    let entry = this.channels.get(channel);
    if (!entry) {
      entry = { handlers: new Set(), ready: this.subscriber.subscribe(channel) };
      this.channels.set(channel, entry);
    }
    entry.handlers.add(handler);
    try {
      await entry.ready;
    } catch (error) {
      // A failed SUBSCRIBE must not stay in the map: the next subscriber retries it.
      entry.handlers.delete(handler);
      if (entry.handlers.size === 0 && this.channels.get(channel) === entry) {
        this.channels.delete(channel);
      }
      throw error;
    }
    return () => {
      const current = this.channels.get(channel);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.channels.delete(channel);
        void this.subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
  }
}
