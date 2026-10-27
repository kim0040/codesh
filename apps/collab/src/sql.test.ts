import {
  COLLAB_DENY_REASONS,
  generateClientId,
  generateShareId,
  type ShareRecord,
  signCollabToken,
} from "@gachipad/shared";
import { openStores } from "@gachipad/storage";
import { expect, it, vi } from "vitest";
import { Collab } from "./collab.js";
import type { ValkeyLock } from "./lock.js";
import { sweep } from "./sweeper.js";

it("refuses a still-valid token issued before a SQL share expired without a sweep", async () => {
  const opened = await openStores("sqlite::memory:");
  try {
    const now = new Date();
    const share: ShareRecord = {
      id: generateShareId(),
      title: "Expiry",
      language: "typescript",
      ownerId: generateClientId(),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      saved: false,
      savedBy: [],
      access: {
        default: "edit",
        editKey: "k",
        pinHash: null,
        requireApproval: false,
        nearby: true,
      },
      bans: [],
      joinCode: "123456",
      locked: false,
      sizeBytes: 0,
    };
    await opened.stores.shares.create(share);
    const secret = "sql-expiry-test-secret";
    const token = await signCollabToken(
      {
        shareId: share.id,
        clientId: share.ownerId,
        name: "Tester",
        color: "#336699",
        role: "owner",
        exp: Math.floor(now.getTime() / 1000) + 600,
      },
      secret,
    );
    const collab = new Collab({ stores: opened.stores, secret } as ConstructorParameters<
      typeof Collab
    >[0]);
    const payload = {
      token,
      documentName: share.id,
      connectionConfig: { readOnly: false },
    } as Parameters<Collab["onAuthenticate"]>[0];
    await expect(collab.onAuthenticate(payload)).resolves.toMatchObject({ shareId: share.id });
    await opened.stores.shares.update(share.id, { expiresAt: new Date(Date.now() - 1) });
    await expect(collab.onAuthenticate(payload)).rejects.toMatchObject({
      reason: COLLAB_DENY_REASONS.notFound,
    });
    expect(await opened.stores.shares.touch(share.id, new Date(), share.expiresAt as Date)).toBe(
      false,
    );
  } finally {
    await opened.close();
  }
});

it("uses SQL label cleanup in the sweeper without per-client hydration", async () => {
  const opened = await openStores("sqlite::memory:");
  try {
    const { stores } = opened;
    const cleanup = vi.fn(stores.labels.deleteInaccessible?.bind(stores.labels));
    stores.labels.deleteInaccessible = cleanup;
    stores.labels.clientIds = async () => {
      throw new Error("per-client scan");
    };
    stores.shares.listForClient = async () => {
      throw new Error("per-client hydration");
    };
    const lock = {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    } as unknown as ValkeyLock;
    expect(await sweep(stores, lock)).toEqual({ orphans: 0 });
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    await opened.close();
  }
});

it("continues SQL sweeping after either expiry cleanup fails without logging content", async () => {
  const opened = await openStores("sqlite::memory:");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { stores } = opened;
    stores.shares.deleteExpired = async () => {
      throw new Error("private share content");
    };
    stores.labs.deleteExpired = async () => {
      throw new Error("private lab content");
    };
    const files = vi.spyOn(stores.files, "deleteExpired");
    const labels = vi.spyOn(stores.labels, "deleteInaccessible");
    const audit = vi.spyOn(stores.audit, "deleteOlderThan");
    const lock = {
      acquire: async () => true,
      renew: async () => true,
      release: vi.fn(async () => true),
    } as unknown as ValkeyLock;
    expect(await sweep(stores, lock)).toEqual({ orphans: 0 });
    expect(files).toHaveBeenCalledOnce();
    expect(labels).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  } finally {
    log.mockRestore();
    await opened.close();
  }
});

it.each([
  ["settings", "get"],
  ["updates", "shareIds"],
  ["snapshots", "shareIds"],
  ["files", "shareIds"],
  ["labels", "shareIds"],
  ["shares", "existing"],
  ["updates", "deleteForShare"],
  ["snapshots", "deleteForShare"],
  ["files", "deleteForShare"],
  ["labels", "deleteForShare"],
  ["labels", "deleteInaccessible"],
  ["snapshots", "deleteOlderThan"],
  ["files", "deleteExpired"],
  ["audit", "deleteOlderThan"],
] as const)("isolates %s.%s failures and logs only a safe code", async (group, method) => {
  const opened = await openStores("sqlite::memory:");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { stores } = opened;
    vi.spyOn(stores.updates, "shareIds").mockResolvedValue(["orphan"]);
    const audit = vi.spyOn(stores.audit, "deleteOlderThan");
    const deletes = vi.spyOn(stores.files, "deleteForShare");
    vi.spyOn(
      stores[group] as unknown as Record<string, () => Promise<unknown>>,
      method,
    ).mockRejectedValue(
      Object.assign(new Error("private value"), {
        code: "ER_LOCK_WAIT_TIMEOUT",
        sql: "private query",
      }),
    );
    const lock = {
      acquire: async () => true,
      renew: vi.fn(async () => true),
      release: vi.fn(async () => true),
    } as unknown as ValkeyLock;
    await expect(sweep(stores, lock)).resolves.toMatchObject({ orphans: expect.any(Number) });
    expect(lock.release).toHaveBeenCalledOnce();
    expect(lock.renew).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("cleanup failed"),
      "ER_LOCK_WAIT_TIMEOUT",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    if (group !== "settings") expect(audit).toHaveBeenCalledOnce();
    if (group === "shares") expect(deletes).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await opened.close();
  }
});

it("renews after expiry and stops safely when the sweeper lock is lost", async () => {
  const opened = await openStores("sqlite::memory:");
  try {
    const expiry = vi.spyOn(opened.stores.labs, "deleteExpired");
    const references = vi.spyOn(opened.stores.updates, "shareIds");
    const lock = {
      acquire: async () => true,
      renew: vi.fn(async () => {
        expect(expiry).toHaveBeenCalledOnce();
        return false;
      }),
      release: vi.fn(async () => true),
    } as unknown as ValkeyLock;
    await expect(sweep(opened.stores, lock)).rejects.toThrow("sweeper lock lost");
    expect(references).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledOnce();
  } finally {
    await opened.close();
  }
});
