import { existsSync } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStores } from "../open.js";
import { openSqlDriver, type SqlDriver } from "../sql/driver.js";
import { CLOSE_TIMEOUT_MS, CopyFailureError, copyDatabase } from "./copy.js";
import { OPERATION_TIMEOUT_MS } from "./timeout.js";

// Pass-through mocks, so that a test can keep one file or connection from opening.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("../sql/driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sql/driver.js")>();
  return { ...actual, openSqlDriver: vi.fn(actual.openSqlDriver) };
});
const actual = {
  open: (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open,
  openSqlDriver: (await vi.importActual<typeof import("../sql/driver.js")>("../sql/driver.js"))
    .openSqlDriver,
};

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(openSqlDriver).mockImplementation(actual.openSqlDriver);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A SQLite source with this code's schema, and a destination path next to it. */
async function sqliteSource() {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-bounds-"));
  tempDirs.push(dir);
  const source = `sqlite:${join(dir, "source.sqlite")}`;
  await (await openStores(source)).close();
  return { source, destination: join(dir, "destination.sqlite") };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Starts a copy; `settled()` tells whether it rejected or resolved yet. */
function startCopy(from: string, to: string) {
  let settled = false;
  const outcome = copyDatabase(from, to)
    .catch((caught: unknown) => caught)
    .finally(() => {
      settled = true;
    });
  return { outcome, settled: () => settled };
}

async function expectTimedOut(run: ReturnType<typeof startCopy>) {
  for (let wait = 0; !run.settled() && wait < 100; wait++) await tick();
  expect(run.settled()).toBe(true);
  expect(await run.outcome).toBeInstanceOf(CopyFailureError);
  expect(await run.outcome).toMatchObject({ code: "ETIMEDOUT", destinationWritten: false });
}

describe("bounded preflight of a database copy", () => {
  it("bounds opening the SQLite source file and closes it when it opens late", async () => {
    const { source, destination } = await sqliteSource();
    let arrive: (() => void) | undefined;
    let late: FileHandle | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        arrive = resolve;
      });
      late = await actual.open(...args);
      vi.spyOn(late, "close");
      return late;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = startCopy(source, `sqlite:${destination}`);
    while (!arrive) await tick();
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectTimedOut(run);
    arrive();
    while (!late || !vi.mocked(late.close).mock.calls.length) await tick();
    expect(existsSync(destination)).toBe(false);
  });

  it("bounds a read of the SQLite source file and the close of that file", async () => {
    const { source, destination } = await sqliteSource();
    const pending = () => new Promise<never>(() => undefined);
    let reading = false;
    vi.mocked(open).mockImplementationOnce(
      async () =>
        ({
          read: () => {
            reading = true;
            return pending();
          },
          close: pending,
        }) as unknown as FileHandle,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = startCopy(source, `sqlite:${destination}`);
    while (!reading) await tick();
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS + CLOSE_TIMEOUT_MS - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectTimedOut(run);
    expect(existsSync(destination)).toBe(false);
  });

  it("bounds opening a SQL source or check connection and closes one that opens late", async () => {
    const { source, destination } = await sqliteSource();
    // Never contacted: opening its driver is what stalls.
    const stalled = "postgres://gp@127.0.0.1:9/gp";
    for (const [from, to] of [
      [stalled, `sqlite:${destination}`],
      [source, stalled],
    ] as const) {
      let arrive: (() => void) | undefined;
      const late = { close: vi.fn(async () => undefined) } as unknown as SqlDriver;
      vi.mocked(openSqlDriver).mockImplementation(async (url, options) => {
        if (!url.startsWith("postgres:")) return actual.openSqlDriver(url, options);
        await new Promise<void>((resolve) => {
          arrive = resolve;
        });
        return late;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = startCopy(from, to);
      while (!arrive) await tick();
      await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS - 1);
      expect(run.settled(), `${from} to ${to}`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expectTimedOut(run);
      arrive();
      while (!vi.mocked(late.close).mock.calls.length) await tick();
      vi.useRealTimers();
    }
    expect(existsSync(destination)).toBe(false);
  });
});
