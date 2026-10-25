import { describe, expect, it, vi } from "vitest";
import { ServerDiagnostics } from "./diagnostics.js";
import { createMemoryStores } from "./memory.js";

describe("server diagnostic mirror", () => {
  it("restores deduplicated events and minute counters after a restart", async () => {
    const stores = createMemoryStores();
    const before = new ServerDiagnostics("api", stores.diagnostics, "stable-instance");
    before.record("server_error", {}, "error");
    before.record("server_error", {}, "error");
    await before.flush();
    const after = new ServerDiagnostics("api", stores.diagnostics, "stable-instance");
    await after.start();
    try {
      expect(after.ring.list()[0]?.count).toBe(2);
      expect(after.snapshot().errorMinutes?.reduce((n, [, count]) => n + count, 0)).toBe(2);
      after.record("server_error", {}, "error");
      expect(after.ring.list()[0]?.count).toBe(3);
    } finally {
      await after.close();
    }
  });
  it("records synchronously while a single bounded mirror write is in flight", async () => {
    let resolve: () => void = () => {};
    const replace = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const recorder = new ServerDiagnostics("api", { replace, list: async () => [] });
    recorder.record("server_error");
    expect(replace).not.toHaveBeenCalled();
    const first = recorder.flush();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) recorder.record("server_error");
    await recorder.flush();
    expect(replace).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    expect(recorder.ring.list()[0]?.count).toBe(101);
  });
  it("keeps only sixteen fixed process slots and retries a failed mirror", async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 40; i++) {
      const recorder = new ServerDiagnostics(
        i % 2 ? "api" : "collab",
        stores.diagnostics,
        String(i),
      );
      recorder.record("mongo_error");
      await recorder.flush();
    }
    expect((await stores.diagnostics.list()).length).toBeLessThanOrEqual(16);
    const replace = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const recorder = new ServerDiagnostics("api", { replace, list: async () => [] });
    recorder.record("mongo_error");
    await recorder.flush();
    await recorder.flush();
    expect(replace).toHaveBeenCalledTimes(2);
  });
});
