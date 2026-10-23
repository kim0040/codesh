import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { Hub } from "./hub.js";

/** Just enough of a subscriber connection: `subscribe` can be made to fail. */
function fakeSubscriber() {
  const calls: string[] = [];
  const listeners: ((channel: string, message: string) => void)[] = [];
  const state = { failNext: 0 };
  const subscriber = {
    on: (_event: string, listener: (channel: string, message: string) => void) => {
      listeners.push(listener);
    },
    subscribe: async (channel: string) => {
      calls.push(`subscribe ${channel}`);
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error("Reached the max retries per request limit");
      }
      return 1;
    },
    unsubscribe: async (channel: string) => {
      calls.push(`unsubscribe ${channel}`);
      return 1;
    },
  };
  return {
    subscriber: subscriber as unknown as Redis,
    calls,
    state,
    deliver: (channel: string, message: string) => {
      for (const listener of listeners) listener(channel, message);
    },
  };
}

describe("Hub", () => {
  it("delivers messages to the handlers of a channel", async () => {
    const fake = fakeSubscriber();
    const hub = new Hub(fake.subscriber);
    const got: string[] = [];
    const off = await hub.subscribe("net:a", (message) => got.push(message));
    fake.deliver("net:a", "one");
    fake.deliver("net:b", "other");
    off();
    fake.deliver("net:a", "two");
    expect(got).toEqual(["one"]);
    expect(fake.calls).toEqual(["subscribe net:a", "unsubscribe net:a"]);
  });

  it("retries a channel after a failed SUBSCRIBE instead of failing every later subscriber", async () => {
    const fake = fakeSubscriber();
    const hub = new Hub(fake.subscriber);
    fake.state.failNext = 1;
    await expect(hub.subscribe("net:a", () => undefined)).rejects.toThrow(/max retries/);

    const got: string[] = [];
    const off = await hub.subscribe("net:a", (message) => got.push(message));
    fake.deliver("net:a", "after the outage");
    expect(got).toEqual(["after the outage"]);
    expect(fake.calls).toEqual(["subscribe net:a", "subscribe net:a"]);
    off();
  });

  it("fails all subscribers that waited for the same failed SUBSCRIBE, and then recovers", async () => {
    const fake = fakeSubscriber();
    const hub = new Hub(fake.subscriber);
    fake.state.failNext = 1;
    const results = await Promise.allSettled([
      hub.subscribe("net:a", () => undefined),
      hub.subscribe("net:a", () => undefined),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const off = await hub.subscribe("net:a", () => undefined);
    expect(typeof off).toBe("function");
  });
});
