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
