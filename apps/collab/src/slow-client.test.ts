import { SLOW_CLIENT_CLOSE_CODE } from "@codesh/shared";
import { describe, expect, it, vi } from "vitest";
import { guardSlowClient, SLOW_CLIENT_TERMINATE_MS } from "./slow-client.js";

function fakeSocket() {
  return {
    sent: [] as unknown[],
    closed: null as null | { code?: number; reason?: string },
    readyState: 1,
    bufferedAmount: 0,
    send(data: unknown) {
      this.sent.push(data);
      this.bufferedAmount += (data as Uint8Array).byteLength;
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
      this.readyState = 2;
    },
    terminated: false,
    terminate() {
      this.terminated = true;
      this.readyState = 3;
    },
  };
}

describe("slow client guard", () => {
  it("closes with 4408 once the send buffer passes the limit", () => {
    const socket = fakeSocket();
    let reported = 0;
    guardSlowClient(socket as never, 1000, () => reported++);
    socket.send(new Uint8Array(600) as never);
    expect(socket.closed).toBeNull();
    socket.send(new Uint8Array(600) as never);
    expect(socket.closed).toEqual({ code: SLOW_CLIENT_CLOSE_CODE, reason: "slow client" });
    expect(socket.sent).toHaveLength(2);
    expect(reported).toBe(1);
  });

  it("reports the size of every message it sends", () => {
    const socket = fakeSocket();
    const sizes: number[] = [];
    guardSlowClient(socket as never, 1000, undefined, (bytes) => sizes.push(bytes));
    socket.send(new Uint8Array(3) as never);
    socket.send(new Uint8Array(5) as never);
    expect(sizes).toEqual([3, 5]);
  });

  it("wraps a socket once even when several documents share it", () => {
    const socket = fakeSocket();
    guardSlowClient(socket as never, 1000);
    const wrapped = socket.send;
    guardSlowClient(socket as never, 1000);
    expect(socket.send).toBe(wrapped);
  });

  it("leaves a draining socket alone", () => {
    const socket = fakeSocket();
    guardSlowClient(socket as never, 1000);
    socket.send(new Uint8Array(900) as never);
    socket.bufferedAmount = 0;
    socket.send(new Uint8Array(900) as never);
    expect(socket.closed).toBeNull();
  });

  it("drops the connection when the close handshake does not finish", () => {
    vi.useFakeTimers();
    try {
      const stalled = fakeSocket();
      const polite = fakeSocket();
      for (const socket of [stalled, polite]) {
        guardSlowClient(socket as never, 1000);
        socket.send(new Uint8Array(1200) as never);
      }
      polite.readyState = 3;
      vi.advanceTimersByTime(SLOW_CLIENT_TERMINATE_MS);
      expect(stalled.terminated).toBe(true);
      expect(polite.terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
