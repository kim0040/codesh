import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ingestCrashDiagnostic, ServerDiagnostics, writeCrashDiagnostic } from "./diagnostics.js";
import { createMemoryStores } from "./memory.js";

describe("server diagnostic mirror", () => {
  it("bounds public request counts to five minutes and refreshes the cached local snapshot", async () => {
    const stores = createMemoryStores();
    const recorder = new ServerDiagnostics("api", stores.diagnostics);
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    await recorder.recent();
    recorder.recordClientIdentity(false, at);
    recorder.recordClientIdentity(true, at);
    expect((await recorder.recent()).snapshots[0]?.clientIdentityMinutes).toEqual([
      [at / 60_000, 2, 1],
    ]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(at + 300_000);
    try {
      expect(recorder.snapshot().clientIdentityMinutes).toEqual([]);
      recorder.recordClientIdentity(false);
      expect(recorder.snapshot().clientIdentityMinutes).toEqual([[at / 60_000 + 5, 1, 0]]);
    } finally {
      clock.mockRestore();
    }
  });
  it("restores deduplicated events and minute counters after a restart", async () => {
    const stores = createMemoryStores();
    const before = new ServerDiagnostics("api", stores.diagnostics, "stable-instance");
    before.record("server_error", {}, "error");
    before.record("server_error", {}, "error");
    before.recordClientIdentity(false);
    before.recordClientIdentity(true);
    await before.flush();
    const after = new ServerDiagnostics("api", stores.diagnostics, "stable-instance");
    await after.start();
    try {
      expect(after.ring.list()[0]?.count).toBe(2);
      expect(after.snapshot().clientIdentityMinutes?.[0]?.slice(1)).toEqual([2, 1]);
      expect(after.snapshot().errorMinutes?.reduce((n, [, count]) => n + count, 0)).toBe(2);
      after.record("server_error", {}, "error");
      expect(after.ring.list()[0]?.count).toBe(3);
    } finally {
      await after.close();
    }
  });
  it("mirrors only valid request counts from the current five minutes", async () => {
    const stores = createMemoryStores();
    const recorder = new ServerDiagnostics("api", stores.diagnostics);
    const minute = Math.floor(Date.now() / 60_000);
    await stores.diagnostics.replace({
      ...recorder.snapshot(),
      clientIdentityMinutes: [
        [minute - 5, 1, 1],
        [minute + 1, 1, 1],
        [minute, 2, 3],
        [minute, -1, 0],
        [minute, 5, 1],
      ],
    });
    expect((await stores.diagnostics.list())[0]?.clientIdentityMinutes).toEqual([[minute, 5, 1]]);
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
  it("writes scrubbed crash details synchronously and ingests them on the next start", () => {
    const dir = mkdtempSync(join(tmpdir(), "gachipad-diag-crash-"));
    const path = join(dir, "tmp", "api-crash.json");
    try {
      writeCrashDiagnostic(path, "uncaught", {
        message: "Error: PRIVATE_DOCUMENT_AND_TOKEN",
        stack: "Error: text\n at boom (file:///private/PRIVATE_DOCUMENT.ts:1:2)",
        code: "ECONNRESET",
      });
      const saved = readFileSync(path, "utf8");
      expect(saved).not.toContain("PRIVATE_DOCUMENT");
      expect(saved).toContain("ECONNRESET");
      const diagnostics = new ServerDiagnostics("api", createMemoryStores().diagnostics);
      expect(ingestCrashDiagnostic(path, diagnostics)).toBe(true);
      expect(diagnostics.ring.list()[0]).toMatchObject({
        kind: "uncaught",
        level: "error",
        details: { code: "ECONNRESET", message: "Error (text omitted)" },
      });
      expect(diagnostics.ring.listBreadcrumbs()[0]?.kind).toBe("uncaught");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("caches admin diagnostics reads for five seconds and exports boot ids and timelines", async () => {
    const list = vi.fn(async () => []);
    const diagnostics = new ServerDiagnostics("api", { replace: async () => {}, list });
    diagnostics.record("mongo_error", { errorCode: 91_234 }, "error");
    const first = await diagnostics.recent();
    const second = await diagnostics.recent();
    expect(list).toHaveBeenCalledTimes(1);
    expect(first.snapshots[0]?.bootId).toBe(diagnostics.bootId);
    expect(second.snapshots[0]?.breadcrumbs[0]).toMatchObject({
      kind: "mongo_error",
      code: 91_234,
    });
    diagnostics.record("response_5xx", {
      route: "/api/admin/overview",
      status: 500,
      code: "unknown",
    });
    const afterRecord = await diagnostics.recent();
    expect(list).toHaveBeenCalledTimes(1);
    expect(afterRecord.events.some((event) => event.kind === "response_5xx")).toBe(true);
  });
});
