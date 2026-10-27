import { type AuditRecord, defaultSettings, type ShareRecord } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../memory.js";
import { CopyRefusedError, CopyVerificationError, copyDatabase } from "./copy.js";
import { registerTransferBackend, transferBackend } from "./registry.js";
import type { TransferBackend } from "./types.js";

const shareId = "Share001";
const ownerId = "11111111-1111-4111-8111-111111111111";
const savedClientId = "22222222-2222-4222-8222-222222222222";
const bannedClientId = "33333333-3333-4333-8333-333333333333";
const labelClientId = "44444444-4444-4444-8444-444444444444";

function sampleShare(): ShareRecord {
  const now = new Date("2026-10-20T08:09:10.123Z");
  return {
    id: shareId,
    title: "안녕하세요 — Copy 你好",
    language: "typescript",
    ownerId,
    createdAt: now,
    updatedAt: new Date(now.getTime() + 1000),
    lastActiveAt: new Date(now.getTime() + 2000),
    expiresAt: null,
    saved: true,
    savedBy: [savedClientId],
    access: {
      default: "edit",
      editKey: "preserved-test-value",
      generation: "generation-3",
      pinHash: null,
      requireApproval: true,
      nearby: false,
      allowParticipantRename: true,
      allowParticipantFiles: true,
      allowParticipantLanguage: false,
    },
    bans: [bannedClientId],
    joinCode: "123456",
    labId: "Lab00001",
    forkOf: "Fork0001",
    locked: true,
    sizeBytes: 256,
    preview: "Unicode preview — 한글",
    previewAt: new Date(now.getTime() + 3000),
  };
}

async function seed(stores: ReturnType<typeof createMemoryStores>) {
  const share = sampleShare();
  await stores.shares.create(share);
  await stores.shares.create({
    ...share,
    id: "Expire01",
    title: "expired but not swept",
    saved: false,
    savedBy: [],
    expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  const updateAt = new Date("2026-10-21T10:11:12.456Z");
  const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
  await stores.updates.append(share.id, [{ seq: 7, data: binary }], updateAt);
  for (const [seq, kind] of [
    [7, "compact"],
    [8, "history"],
  ] as const) {
    await stores.snapshots.put({
      shareId,
      seq,
      at: new Date(updateAt.getTime() + seq),
      kind,
      state: binary,
    });
  }

  const uploadSize = 3 * 1024 * 1024 + 37;
  const upload = await stores.files.putStream({
    name: "sample.bin",
    contentType: "application/octet-stream",
    ownerId,
    shareId,
    expiresAt: new Date("2027-01-02T03:04:05.678Z"),
    stream: (async function* () {
      for (let offset = 0; offset < uploadSize; offset += 257 * 1024) {
        const length = Math.min(257 * 1024, uploadSize - offset);
        yield Uint8Array.from({ length }, (_, index) => (offset + index) % 256);
      }
    })(),
  });

  await stores.labs.create({
    id: "Lab00001",
    title: "자료실 — 漢字",
    ownerId,
    joinCode: "654321",
    templateShareId: shareId,
    locked: false,
    students: [
      {
        clientId: savedClientId,
        name: "학생 한 명",
        shareId: "Stud0001",
        joinedAt: new Date("2026-10-19T12:13:14.015Z"),
      },
    ],
    createdAt: new Date("2026-10-18T11:12:13.014Z"),
    expiresAt: new Date("2027-10-18T11:12:13.014Z"),
  });
  await stores.labels.set(
    labelClientId,
    shareId,
    { folder: "수업 / A", tags: ["문서", "共有"] },
    new Date("2026-10-22T09:08:07.006Z"),
  );
  await stores.settings.put({
    ...defaultSettings(),
    guestAllowed: false,
    contact: "ops@example.invalid",
  });
  const audit: AuditRecord = {
    at: new Date("2026-10-23T06:05:04.003Z"),
    actor: ownerId,
    ip: "192.0.2.3",
    action: "share.saved",
    shareId,
    detail: { label: "保存しました", nested: { value: 3 } },
  };
  await stores.audit.append(audit);
  return { share, updateAt, binary, upload, uploadSize, audit };
}

function openPair(
  source: ReturnType<typeof createMemoryStores>,
  destination: ReturnType<typeof createMemoryStores>,
) {
  return async (url: string) => ({
    stores: url === "memory:" ? source : destination,
    close: async () => undefined,
    kind: "memory" as const,
  });
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(Uint8Array.from(chunk as Uint8Array));
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("database transfer", () => {
  it("copies each persistent kind and streams a multi-chunk upload", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    const fixture = await seed(source);
    const result = await copyDatabase("memory:", "memory://", {
      openStores: openPair(source, destination),
    });

    expect(result.counts).toEqual({
      shares: 2,
      updates: 1,
      snapshots: 2,
      uploads: 1,
      labs: 1,
      labels: 1,
      settings: 1,
      audit: 1,
    });
    expect(await destination.shares.get(shareId)).toEqual(fixture.share);
    expect(await destination.shares.get("Expire01")).toEqual(await source.shares.get("Expire01"));
    expect(await destination.updates.read(shareId, 0)).toEqual([{ seq: 7, data: fixture.binary }]);
    expect(await destination.updates.lastSeq(shareId)).toBe(7);
    expect(await destination.snapshots.get(shareId, "compact", 7)).toEqual({
      shareId,
      seq: 7,
      at: new Date(fixture.updateAt.getTime() + 7),
      kind: "compact",
      state: fixture.binary,
    });
    expect(await destination.snapshots.get(shareId, "history", 8)).toMatchObject({
      kind: "history",
      seq: 8,
    });
    expect(await destination.labs.get("Lab00001")).toEqual(await source.labs.get("Lab00001"));
    expect(await destination.labels.get(labelClientId, shareId)).toEqual(
      await source.labels.get(labelClientId, shareId),
    );
    expect(await destination.settings.get()).toEqual(await source.settings.get());
    expect(await destination.audit.list({ limit: 10 })).toEqual(
      await source.audit.list({ limit: 10 }),
    );

    const copiedUpload = await destination.files.openDownload(fixture.upload.id);
    const originalUpload = await source.files.openDownload(fixture.upload.id);
    if (!copiedUpload || !originalUpload) throw new Error("The upload was not copied");
    expect(copiedUpload.meta).toEqual(originalUpload.meta);
    const copiedBytes = await readStream(copiedUpload.stream);
    expect(copiedBytes.byteLength).toBe(fixture.uploadSize);
    expect(copiedBytes).toEqual(await readStream(originalUpload.stream));
  });

  it("refuses a destination that already has a record", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    await destination.shares.create(sampleShare());
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
    expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
  });

  it("fails verification and leaves the copied destination intact", async () => {
    const source = createMemoryStores();
    const destination = createMemoryStores();
    await seed(source);
    const actual = transferBackend(destination);
    const mismatching: TransferBackend = {
      ...actual,
      async *exportAll() {
        for await (const item of actual.exportAll()) {
          if (item.kind === "shares") yield { ...item, record: { ...item.record, title: "wrong" } };
          else yield item;
        }
      },
    };
    registerTransferBackend(destination, mismatching);
    await expect(
      copyDatabase("memory:", "memory://", { openStores: openPair(source, destination) }),
    ).rejects.toBeInstanceOf(CopyVerificationError);
    expect((await destination.shares.get(shareId))?.title).toBe(sampleShare().title);
  });

  it("refuses identical URLs before opening either backend", async () => {
    let opened = false;
    await expect(
      copyDatabase("sqlite:/tmp/gp-copy-same.db", "sqlite:/tmp/gp-copy-same.db", {
        openStores: async () => {
          opened = true;
          throw new Error("must not open");
        },
      }),
    ).rejects.toBeInstanceOf(CopyRefusedError);
    expect(opened).toBe(false);
  });

  it("refuses an unsupported URL scheme", async () => {
    await expect(copyDatabase("couchdb://localhost/data", "memory://")).rejects.toBeInstanceOf(
      CopyRefusedError,
    );
  });
});
