import { participantPermissions, YDOC } from "@codesh/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadPersisted } from "./persisted-doc.js";
import type { CollabServer } from "./server.js";
import { Harness, servicesAvailable, sleep, waitFor } from "./testing/harness.js";

const available = await servicesAvailable();
describe.runIf(available)("participant document permissions", () => {
  let h: Harness;
  let server: CollabServer;
  beforeAll(async () => {
    h = await Harness.create();
    server = await h.startServer();
  });
  afterAll(() => h?.close());

  async function room() {
    const share = await h.createShare({
      access: {
        default: "edit",
        editKey: "key",
        pinHash: null,
        requireApproval: false,
        nearby: false,
      },
    });
    const owner = await h.connect(server.webSocketURL, share.id, {
      role: "owner",
      clientId: share.ownerId,
    });
    await owner.synced;
    owner.doc.transact(() => {
      owner.doc.getMap(YDOC.meta).set("title", "Original");
      const file = new Y.Map();
      owner.doc.getMap(YDOC.files).set("main", file);
      file.set("path", "main.ts");
      file.set("language", "typescript");
      owner.text.insert(0, "current");
    });
    await waitFor(
      () =>
        server.collab.docs.get(share.id)?.document.getMap(YDOC.meta).get("title") === "Original",
      "seeded",
    );
    const editor = await h.connect(server.webSocketURL, share.id);
    const viewer = await h.connect(server.webSocketURL, share.id, { role: "view" });
    await Promise.all([editor.synced, viewer.synced]);
    return { share, owner, editor, viewer };
  }
  it("rejects an editor's mixed title/text update before broadcast and persistence, then resyncs cleanly", async () => {
    const { share, owner, editor, viewer } = await room();
    editor.doc.transact(() => {
      editor.doc.getMap(YDOC.meta).set("title", "FORBIDDEN_TITLE");
      editor.text.insert(0, "FORBIDDEN_TEXT");
    });
    await waitFor(
      () =>
        editor.stateless.some(
          (message) => (message as { type: string }).type === "permission_refused",
        ),
      "refused",
    );
    expect(owner.doc.getMap(YDOC.meta).get("title")).toBe("Original");
    expect(viewer.text.toString()).toBe("current");
    expect(
      viewer.received.some((bytes) => new TextDecoder().decode(bytes).includes("FORBIDDEN")),
    ).toBe(false);
    await server.collab.flushAll();
    const stored = new Y.Doc();
    const persisted = await loadPersisted(h.stores, share.id);
    if (persisted.state) Y.applyUpdate(stored, persisted.state);
    expect(stored.getMap(YDOC.meta).get("title")).toBe("Original");
    expect(stored.getText("file:main").toString()).toBe("current");
    // Like DocSession.resync: a fresh doc drops rejected CRDT clocks instead of merging the state.
    editor.destroy();
    const healed = await h.connect(server.webSocketURL, share.id, { clientId: editor.clientId });
    await healed.synced;
    expect(healed.doc.getMap(YDOC.meta).get("title")).toBe("Original");
    healed.text.insert(0, "allowed;");
    await waitFor(() => owner.text.toString() === "allowed;current", "text remains editable");
  });
  it("pushes toggles live, permits rename when enabled and refuses it again after revocation", async () => {
    const { share, owner, editor } = await room();
    await h.stores.shares.update(share.id, { access: { allowParticipantRename: true } });
    await h.publishPerm(share.id, { kind: "permissions", version: 1 });
    await waitFor(
      () =>
        editor.stateless.some(
          (m) => (m as { permissions?: { rename: boolean } }).permissions?.rename === true,
        ),
      "rename enabled live",
    );
    editor.doc.getMap(YDOC.meta).set("title", "Allowed");
    await waitFor(() => owner.doc.getMap(YDOC.meta).get("title") === "Allowed", "rename received");
    await h.stores.shares.update(share.id, { access: { allowParticipantRename: false } });
    await h.publishPerm(share.id, { kind: "permissions", version: 2 });
    await waitFor(
      () => participantPermissions(server.collab.docs.get(share.id)?.share.access).rename === false,
      "rename disabled",
    );
    editor.doc.getMap(YDOC.meta).set("title", "Refused");
    await waitFor(
      () => editor.stateless.some((m) => (m as { type: string }).type === "permission_refused"),
      "revoked rename refused",
    );
    expect(owner.doc.getMap(YDOC.meta).get("title")).toBe("Allowed");
  });
  it("refuses every viewer mutation even when all participant toggles are enabled", async () => {
    const { share, owner, viewer } = await room();
    await h.stores.shares.update(share.id, {
      access: {
        allowParticipantRename: true,
        allowParticipantFiles: true,
        allowParticipantLanguage: true,
      },
    });
    await h.publishPerm(share.id, { kind: "permissions", version: 1 });
    viewer.doc.transact(() => {
      viewer.doc.getMap(YDOC.meta).set("title", "viewer");
      viewer.doc.getMap(YDOC.files).delete("main");
      viewer.text.delete(0, viewer.text.length);
      viewer.doc.getArray(YDOC.comments).push([{ body: "viewer" }]);
    });
    await waitFor(
      () => viewer.stateless.some((m) => (m as { type: string }).type === "permission_refused"),
      "viewer refusal",
    );
    expect(owner.text.toString()).toBe("current");
    expect(owner.doc.getMap(YDOC.files).has("main")).toBe(true);
    expect(owner.doc.getArray(YDOC.comments).length).toBe(0);
  });
  it("keeps file structure and language independent and ignores forged presenter awareness", async () => {
    const { share, owner, editor } = await room();
    await h.stores.shares.update(share.id, { access: { allowParticipantLanguage: true } });
    await h.publishPerm(share.id, { kind: "permissions", version: 1 });
    await waitFor(
      () => participantPermissions(server.collab.docs.get(share.id)?.share.access).language,
      "language allowed",
    );
    editor.doc.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.set("language", "python");
    await waitFor(
      () => owner.doc.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.get("language") === "python",
      "language received",
    );
    editor.provider.awareness?.setLocalStateField("presenting", true);
    await sleep(100);
    expect(
      [...(owner.provider.awareness?.getStates().values() ?? [])].some((s) => s.presenting),
    ).toBe(false);
    editor.doc.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.set("path", "renamed.py");
    await waitFor(
      () => editor.stateless.some((m) => (m as { type: string }).type === "permission_refused"),
      "structure refused",
    );
    expect(owner.doc.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.get("path")).toBe("main.ts");
  });
});
