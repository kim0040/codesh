import {
  COLLAB_COMMAND_ERRORS,
  generateFileId,
  generateShareId,
  keys,
  YDOC,
} from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { CollabServer } from "./server.js";
import { Harness, servicesAvailable, storedText, waitFor } from "./testing/harness.js";

const available = await servicesAvailable();

const requestId = () => crypto.randomUUID();

function stateOf(text: string): string {
  const doc = new Y.Doc();
  doc.getText(YDOC.fileText("main")).insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function core(server: CollabServer, shareId: string) {
  const state = server.collab.docs.get(shareId);
  if (!state) throw new Error(`${shareId} is not loaded`);
  return state.core;
}

describe.runIf(available)("collab content commands (§6.11)", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness?.close());

  const historySeqs = async (shareId: string) =>
    (await harness.stores.snapshots.list(shareId, "history")).map((h) => h.seq);

  it("restores a history snapshot for every connected client and keeps history growing", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const a = await harness.connect(server.webSocketURL, share.id);
    const b = await harness.connect(server.webSocketURL, share.id);
    await Promise.all([a.synced, b.synced]);

    a.text.insert(0, "first version");
    await waitFor(() => b.text.toString() === "first version", "b sees the first version");
    await core(server, share.id).history(true);
    const [seq] = await historySeqs(share.id);
    expect(seq).toBeDefined();

    b.text.delete(0, "first".length);
    b.text.insert(0, "second");
    await waitFor(() => a.text.toString() === "second version", "a sees the second version");

    const replies = await harness.command(share.id, {
      requestId: requestId(),
      kind: "restore",
      seq: seq as number,
    });
    expect(replies).toEqual([{ ok: true }]);
    await waitFor(
      () => a.text.toString() === "first version" && b.text.toString() === "first version",
      "both clients restored",
    );
    expect(await storedText(harness.stores, share.id)).toBe("first version");
    const history = await historySeqs(share.id);
    expect(history[0]).toBe(seq);
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history.at(-1)).toBeGreaterThan(seq as number);

    // Editing goes on as usual after a restore.
    a.text.insert(0, "> ");
    await waitFor(() => b.text.toString() === "> first version", "edit after restore");
  });

  it("restores a doc that is not loaded on any instance", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const first = await harness.connect(server.webSocketURL, share.id);
    await first.synced;
    first.text.insert(0, "v1");
    first.destroy();
    await waitFor(() => !server.collab.docs.has(share.id), "first unload");
    const [seq] = await historySeqs(share.id);

    const second = await harness.connect(server.webSocketURL, share.id);
    await second.synced;
    second.text.delete(0, 2);
    second.text.insert(0, "v2");
    second.destroy();
    await waitFor(() => !server.collab.docs.has(share.id), "second unload");
    expect(await storedText(harness.stores, share.id)).toBe("v2");
    expect(await harness.redis.exists(keys.docLock(share.id))).toBe(0);
    const before = (await historySeqs(share.id)).length;

    const replies = await harness.command(share.id, {
      requestId: requestId(),
      kind: "restore",
      seq: seq as number,
    });
    expect(replies).toEqual([{ ok: true }]);
    expect(await storedText(harness.stores, share.id)).toBe("v1");
    expect((await historySeqs(share.id)).length).toBeGreaterThan(before);

    const reader = await harness.connect(server.webSocketURL, share.id);
    await reader.synced;
    expect(reader.text.toString()).toBe("v1");
  });

  it("handles a command exactly once with two collab instances", async () => {
    // Long enough that the doc a command loaded is still in memory when the test looks.
    const timings = { unloadDelayMs: 10_000 };
    const one = await harness.startServer({ timings });
    const two = await harness.startServer({ timings });
    const servers = [one, two];

    // Not loaded anywhere: both race for the doc lock, one wins.
    const share = await harness.createShare();
    const replies = await harness.command(
      share.id,
      { requestId: requestId(), kind: "replace", state: stateOf("replaced") },
      1000,
    );
    expect(replies).toEqual([{ ok: true }]);
    // The winner may already have unloaded the doc under load; it must never be on both.
    expect(servers.filter((s) => s.collab.docs.has(share.id)).length).toBeLessThanOrEqual(1);
    expect(await storedText(harness.stores, share.id)).toBe("replaced");

    // Loaded on both: only the lock holder answers, clients on both converge.
    const live = await harness.createShare();
    const a = await harness.connect(one.webSocketURL, live.id);
    await a.synced;
    const b = await harness.connect(two.webSocketURL, live.id);
    await b.synced;
    a.text.insert(0, "typed");
    await waitFor(() => b.text.toString() === "typed", "b sees typing");
    expect(core(one, live.id).owner).toBe(true);
    expect(core(two, live.id).owner).toBe(false);

    const again = await harness.command(
      live.id,
      { requestId: requestId(), kind: "replace", state: stateOf("replaced live") },
      1000,
    );
    expect(again).toEqual([{ ok: true }]);
    await waitFor(
      () => a.text.toString() === "replaced live" && b.text.toString() === "replaced live",
      "both instances converge",
    );
    await waitFor(() => core(one, live.id).pendingUpdates === 0, "flush");
    expect(await storedText(harness.stores, live.id)).toBe("replaced live");
  });

  it("sets meta and per-file language, and mirrors meta into the share record", async () => {
    const server = await harness.startServer({ timings: { metaMirrorMs: 100 } });
    const share = await harness.createShare({ title: "Old", language: "typescript" });
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    const files = client.doc.getMap<Y.Map<unknown>>(YDOC.files);
    files.set(
      "main",
      new Y.Map<unknown>([
        ["path", "main.ts"],
        ["language", "typescript"],
        ["order", 0],
      ]),
    );
    await waitFor(
      () => server.collab.docs.get(share.id)?.document.getMap(YDOC.files).has("main") === true,
      "file entry on the server",
    );

    expect(
      await harness.command(share.id, {
        requestId: requestId(),
        kind: "meta",
        title: "Renamed",
        language: "python",
      }),
    ).toEqual([{ ok: true }]);
    expect(
      await harness.command(share.id, {
        requestId: requestId(),
        kind: "meta",
        fileId: "main",
        language: "go",
      }),
    ).toEqual([{ ok: true }]);
    expect(
      await harness.command(share.id, {
        requestId: requestId(),
        kind: "meta",
        fileId: generateFileId(),
        language: "go",
      }),
    ).toEqual([{ ok: false, error: COLLAB_COMMAND_ERRORS.fileNotFound }]);

    const meta = client.doc.getMap(YDOC.meta);
    await waitFor(() => files.get("main")?.get("language") === "go", "file language");
    expect(meta.toJSON()).toEqual({ title: "Renamed", language: "python" });
    await waitFor(async () => {
      const record = await harness.stores.shares.get(share.id);
      return record?.title === "Renamed" && record.language === "python";
    }, "share record mirrors the command");

    // Edits from the editor are mirrored too, at most once per throttle interval.
    const before = (await harness.stores.shares.get(share.id))?.updatedAt.getTime() ?? 0;
    meta.set("title", "Typed");
    meta.set("title", "Typed title");
    await waitFor(
      async () => (await harness.stores.shares.get(share.id))?.title === "Typed title",
      "share record mirrors the editor",
    );
    const record = await harness.stores.shares.get(share.id);
    expect(record?.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(record?.language).toBe("python");
  });

  it("answers invalid and impossible commands", async () => {
    const server = await harness.startServer();
    const share = await harness.createShare();
    const client = await harness.connect(server.webSocketURL, share.id);
    await client.synced;
    client.text.insert(0, "untouched");

    const reply = async (message: Record<string, unknown>) =>
      harness.command(share.id, { requestId: requestId(), ...message });
    expect(await reply({ kind: "restore", seq: 999 })).toEqual([
      { ok: false, error: COLLAB_COMMAND_ERRORS.snapshotNotFound },
    ]);
    expect(await reply({ kind: "replace", state: "not base64!" })).toEqual([
      { ok: false, error: COLLAB_COMMAND_ERRORS.invalid },
    ]);
    expect(
      await reply({ kind: "replace", state: Buffer.from("garbage!").toString("base64") }),
    ).toEqual([{ ok: false, error: COLLAB_COMMAND_ERRORS.invalid }]);
    expect(await reply({ kind: "unknown" })).toEqual([
      { ok: false, error: COLLAB_COMMAND_ERRORS.invalid },
    ]);
    expect(
      await harness.command(
        generateShareId(),
        {
          requestId: requestId(),
          kind: "meta",
          title: "x",
        },
        200,
      ),
    ).toEqual([{ ok: false, error: COLLAB_COMMAND_ERRORS.notFound }]);
    expect(client.text.toString()).toBe("untouched");
  });
});
