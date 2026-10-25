import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Collab } from "./collab.js";

describe("beforeSync document state", () => {
  it("fails closed when a content update has no loaded state", async () => {
    const collab = new Collab({} as ConstructorParameters<typeof Collab>[0]);
    const doc = Object.assign(new Y.Doc(), { name: "missing" });
    const connection = { readOnly: false, close: vi.fn() };
    await collab.beforeSync({
      connection,
      document: doc,
      type: 2,
      payload: new Uint8Array(),
    } as unknown as Parameters<Collab["beforeSync"]>[0]);
    expect(connection.readOnly).toBe(true);
    expect(connection.close).toHaveBeenCalledWith({
      code: 4401,
      reason: "Document state unavailable",
    });
    doc.destroy();
  });

  it.each(["text", "metadata", "viewer"])(
    "waits for the initial full sync after an auth retry (%s)",
    async (kind) => {
      const collab = new Collab({} as ConstructorParameters<typeof Collab>[0]);
      const doc = Object.assign(new Y.Doc(), { name: "retry" });
      doc.getMap("meta").set("title", "Original");
      doc.getText("file:main").insert(0, "base");
      collab.docs.set(doc.name, {
        share: { access: {} },
        locked: false,
        core: { sizeEstimate: 0 },
      } as unknown as NonNullable<ReturnType<typeof collab.docs.get>>);
      const connection = {
        readOnly: kind === "viewer",
        context: { role: kind === "viewer" ? "view" : "edit", controller: false },
        sendStateless: vi.fn(),
        send: vi.fn(),
        messageAddress: doc.name,
      };
      const local = new Y.Doc();
      Y.applyUpdate(local, Y.encodeStateAsUpdate(doc));
      const updates: Uint8Array[] = [];
      local.on("update", (update: Uint8Array) => updates.push(update));
      local.getText("file:main").insert(4, " first");
      local.getText("file:main").insert(10, " second");
      if (kind === "metadata") local.getMap("meta").set("title", "Forbidden");
      const handle = async (type: number, payload: Uint8Array) => {
        const args = { connection, document: doc, type, payload };
        await collab.beforeSync(args as unknown as Parameters<Collab["beforeSync"]>[0]);
        if (!connection.readOnly) Y.applyUpdate(doc, payload);
        await collab.afterHandleMessage(
          args as unknown as Parameters<Collab["afterHandleMessage"]>[0],
        );
      };
      // Failed authentication discarded the first increment. The retry drains the second
      // before SyncStep2 supplies both; refusing it as a permission violation loses valid edits.
      await handle(2, updates[1] as Uint8Array);
      expect(doc.getText("file:main").toString()).toBe("base");
      expect(doc.store.pendingStructs).toBeNull();
      expect(connection.sendStateless).not.toHaveBeenCalled();

      await handle(1, Y.encodeStateAsUpdate(local, Y.encodeStateVector(doc)));
      if (kind === "text") {
        expect(doc.getText("file:main").toString()).toBe("base first second");
        expect(connection.sendStateless).not.toHaveBeenCalled();
        // The held-back update was answered "not saved"; the accepted sync confirms it once.
        expect(connection.send).toHaveBeenCalledTimes(1);
        local.getText("file:main").insert(17, " third");
        await handle(2, updates.at(-1) as Uint8Array);
        expect(doc.getText("file:main").toString()).toBe("base first second third");
      } else {
        expect(doc.getText("file:main").toString()).toBe("base");
        expect(connection.sendStateless).toHaveBeenCalledWith(
          JSON.stringify({ type: "permission_refused" }),
        );
        expect(connection.send).not.toHaveBeenCalled();
      }
      expect(doc.getMap("meta").get("title")).toBe("Original");
      local.destroy();
      doc.destroy();
    },
  );
});
