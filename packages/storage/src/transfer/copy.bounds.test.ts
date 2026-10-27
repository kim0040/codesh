import { existsSync } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStores } from "../open.js";
import { openSqlDriver, type SqlDriver } from "../sql/driver.js";
import { CLOSE_TIMEOUT_MS, CopyDeadlineError, CopyFailureError, copyDatabase } from "./copy.js";
import { OPERATION_TIMEOUT_MS } from "./timeout.js";

// Pass-through mocks, so that a test can keep one file or connection from opening, or change the
// source between two steps of the copy.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock("../sql/driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sql/driver.js")>();
  return { ...actual, openSqlDriver: vi.fn(actual.openSqlDriver) };
});
/** When a test sets `connect`, a MongoDB connect waits for it instead of connecting. */
const mongo = vi.hoisted(() => ({
  connect: undefined as ((client: object) => Promise<void>) | undefined,
}));
vi.mock("mongodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongodb")>();
  class MongoClient extends actual.MongoClient {
    override async connect(): Promise<this> {
      if (!mongo.connect) return super.connect();
      await mongo.connect(this);
      return this;
    }
  }
  return { ...actual, MongoClient };
});
const actual = {
  open: (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open,
  openSqlDriver: (await vi.importActual<typeof import("../sql/driver.js")>("../sql/driver.js"))
    .openSqlDriver,
};

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(openSqlDriver).mockImplementation(actual.openSqlDriver);
  mongo.connect = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A SQLite source with this code's schema, and a destination path next to it. */
async function sqliteSource() {
  const dir = await mkdtemp(join(tmpdir(), "gp-copy-bounds-"));
  tempDirs.push(dir);
  const file = join(dir, "source.sqlite");
  const source = `sqlite:${file}`;
  await (await openStores(source)).close();
  return { source, file, destination: join(dir, "destination.sqlite") };
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
          stat: async () => ({ dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n }),
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

  it("closes a MongoDB client whose connect ends after the timeout", async () => {
    const { destination } = await sqliteSource();
    let arrive: (() => void) | undefined;
    let closes = () => 0;
    mongo.connect = async (client) => {
      const close = vi.spyOn(client as MongoClient, "close");
      closes = () => close.mock.calls.length;
      await new Promise<void>((resolve) => {
        arrive = resolve;
      });
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Never contacted: its connect is held until the copy has given up on it.
    const run = startCopy("mongodb://127.0.0.1:9/gp", `sqlite:${destination}`);
    while (!arrive) await tick();
    await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (let wait = 0; !run.settled() && wait < 100; wait++) await tick();
    expect(run.settled()).toBe(true);
    expect(await run.outcome).toBeInstanceOf(CopyFailureError);
    expect(await run.outcome).toMatchObject({ destinationWritten: false });
    expect(closes()).toBe(1);
    // The connect ends now, as one that went on to open connections would: closed once more.
    arrive();
    for (let wait = 0; closes() < 2 && wait < 100; wait++) await tick();
    expect(closes()).toBe(2);
    expect(existsSync(destination)).toBe(false);
  });
});

const MINUTE = 60_000;
const DEADLINE = 10 * MINUTE;
/** Bytes one slowed read of a SQLite source returns, so that a small file takes many reads. */
const CHUNK = 1024;

/** A monotonic clock that moves only when a test moves it, in whole milliseconds. */
function frozenClock() {
  const clock = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  return clock;
}

/** The handle, with each read passed through `read` first. */
function slowed(handle: FileHandle, read: () => Promise<never> | undefined): FileHandle {
  return {
    stat: handle.stat.bind(handle),
    close: handle.close.bind(handle),
    read: (buffer: Buffer, offset: number, length: number, position: number) =>
      read() ?? handle.read(buffer, offset, Math.min(length, CHUNK), position),
  } as unknown as FileHandle;
}

describe("deadline of the reads of a SQLite source file", () => {
  it("charges a slow but progressing first or last read of the file to the deadline", async () => {
    // The file is read in full before the open and again after the last read of the copy.
    for (const scan of [1, 2]) {
      const { source, file, destination } = await sqliteSource();
      expect((await stat(file)).size).toBeGreaterThan(20 * CHUNK);
      const clock = frozenClock();
      let opens = 0;
      let reads = 0;
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (++opens !== scan) return handle;
        // Every read answers at once with the next bytes, a minute later on the monotonic clock.
        return slowed(handle, () => {
          reads++;
          clock.now += MINUTE;
          return undefined;
        });
      });
      const outcome = await copyDatabase(source, `sqlite:${destination}`).catch(
        (caught: unknown) => caught,
      );
      expect(outcome, `read ${scan}`).toBeInstanceOf(CopyDeadlineError);
      expect(outcome).toMatchObject({ minutes: 10, destinationWritten: scan === 2 });
      // Stopped at the deadline, long before the end of the file.
      expect(reads).toBe(DEADLINE / MINUTE);
      expect(existsSync(destination)).toBe(scan === 2);
    }
  });

  it("bounds a wait for the file by the time left before the deadline", async () => {
    const { source, destination } = await sqliteSource();
    const clock = frozenClock();
    let reads = 0;
    vi.mocked(open).mockImplementationOnce(async (...args) =>
      // The first read ends 30 seconds before the deadline; the next one never answers.
      slowed(await actual.open(...args), () => {
        if (reads++) return new Promise<never>(() => undefined);
        clock.now += DEADLINE - 30_000;
        return undefined;
      }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = startCopy(source, `sqlite:${destination}`);
    while (reads < 2) await tick();
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    for (let wait = 0; !run.settled() && wait < 100; wait++) await tick();
    expect(run.settled()).toBe(true);
    expect(await run.outcome).toBeInstanceOf(CopyDeadlineError);
    expect(await run.outcome).toMatchObject({ destinationWritten: false });
    expect(existsSync(destination)).toBe(false);
  });
});

describe("SQLite source file of a database copy", () => {
  const lab = (title: string) => ({
    id: "LabFile1",
    title,
    ownerId: "11111111-1111-4111-8111-111111111111",
    joinCode: "100001",
    templateShareId: null,
    locked: false,
    students: [],
    createdAt: new Date(1),
    expiresAt: new Date(Date.now() + 24 * 60 * MINUTE),
  });

  it("opens the file it read first and fails when the source path changes before the open", async () => {
    for (const change of ["relink", "replace", "link folder", "relink and restore"] as const) {
      const dir = await mkdtemp(join(tmpdir(), "gp-copy-identity-"));
      tempDirs.push(dir);
      // Two sources of the same schema, with different data.
      const a = join(dir, "a", "source.sqlite");
      const b = join(dir, "b", "source.sqlite");
      for (const [file, title] of [
        [a, "A"],
        [b, "B"],
      ] as const) {
        await mkdir(dirname(file));
        const opened = await openStores(`sqlite:${file}`);
        await opened.stores.labs.create(lab(title));
        await opened.close();
      }
      const link = join(dir, "current.sqlite");
      await symlink(a, link);
      /** Points the link elsewhere in one step, as a deployment tool would. */
      const relink = async (target: string) => {
        await symlink(target, `${link}.next`);
        await rename(`${link}.next`, link);
      };
      vi.mocked(openSqlDriver).mockImplementationOnce(async (url, options) => {
        // The copy has read the source file and opens it now.
        if (change === "replace") await rename(b, a);
        else if (change === "link folder") {
          await rename(join(dir, "a"), join(dir, "a-old"));
          await symlink(join(dir, "b"), join(dir, "a"));
        } else await relink(b);
        const driver = await actual.openSqlDriver(url, options);
        if (change === "relink and restore") await relink(a);
        return driver;
      });
      const destination = join(dir, "destination.sqlite");
      const outcome = await copyDatabase(
        `sqlite:${change === "link folder" ? a : link}`,
        `sqlite:${destination}`,
      ).catch((caught: unknown) => caught);
      if (change === "relink and restore") {
        // SQLite opened the file the link named when it was read, never the other one.
        expect(outcome, change).toMatchObject({ counts: { labs: 1 } });
        const copied = await openStores(`sqlite:${destination}`);
        expect((await copied.stores.labs.get("LabFile1"))?.title).toBe("A");
        await copied.close();
      } else {
        expect(outcome, change).toBeInstanceOf(CopyFailureError);
        expect(outcome, change).toMatchObject({ destinationWritten: false });
        expect(existsSync(destination), change).toBe(false);
      }
    }
  });
});
