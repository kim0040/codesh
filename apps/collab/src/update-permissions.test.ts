import { participantPermissions, YDOC } from "@codesh/shared";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { hasNewOperations, permitsUpdate } from "./update-permissions.js";

function fixture() {
  const doc = new Y.Doc();
  doc.getMap(YDOC.meta).set("title", "Original");
  const file = new Y.Map<unknown>();
  doc.getMap(YDOC.files).set("main", file);
  file.set("path", "main.ts");
  file.set("language", "typescript");
  file.set("order", 0);
  doc.getText(YDOC.fileText("main")).insert(0, "hello");
  return doc;
}
function change(doc: Y.Doc, edit: (copy: Y.Doc) => void) {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(doc);
  edit(copy);
  const update = Y.encodeStateAsUpdate(copy, vector);
  copy.destroy();
  return Y.decodeUpdate(update);
}
const none = participantPermissions();
const all = { rename: true, files: true, language: true };

describe("Yjs permission classifier", () => {
  it.each(["insert", "delete"])(
    "restricts title %s and allows it only with rename permission",
    (kind) => {
      const doc = fixture();
      const update = change(doc, (copy) =>
        kind === "delete"
          ? copy.getMap(YDOC.meta).delete("title")
          : copy.getMap(YDOC.meta).set("title", "Forged"),
      );
      expect(permitsUpdate(doc, update, none)).toBe(false);
      expect(permitsUpdate(doc, update, { ...none, rename: true })).toBe(true);
      expect(doc.getMap(YDOC.meta).get("title")).toBe("Original");
    },
  );
  it.each(["add", "rename", "delete", "move", "replace"])(
    "restricts file %s independently of language permission",
    (kind) => {
      const doc = fixture();
      const update = change(doc, (copy) => {
        const files = copy.getMap<Y.Map<unknown>>(YDOC.files);
        if (kind === "add" || kind === "replace") {
          const entry = new Y.Map();
          files.set(kind === "add" ? "new" : "main", entry);
          entry.set("language", "python");
        } else if (kind === "delete") files.delete("main");
        else
          files
            .get("main")
            ?.set(kind === "move" ? "order" : "path", kind === "move" ? 1 : "src/main.ts");
      });
      expect(permitsUpdate(doc, update, { ...none, language: true })).toBe(false);
      expect(permitsUpdate(doc, update, { ...none, files: true })).toBe(true);
    },
  );
  it("distinguishes a file language and the share's mirrored language", () => {
    const doc = fixture();
    const update = change(doc, (copy) => {
      copy.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.set("language", "python");
      copy.getMap(YDOC.meta).set("language", "python");
    });
    expect(permitsUpdate(doc, update, none)).toBe(false);
    expect(permitsUpdate(doc, update, { ...none, files: true })).toBe(false);
    expect(permitsUpdate(doc, update, { ...none, language: true })).toBe(true);
  });
  it("file permission initializes new file languages but cannot change an existing language", () => {
    const doc = fixture();
    const update = change(doc, (copy) =>
      copy.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.set("language", "go"),
    );
    expect(permitsUpdate(doc, update, { ...none, files: true })).toBe(false);
    expect(permitsUpdate(doc, update, { ...none, language: true })).toBe(true);
  });
  it("allows inserts, replacement and delete-only text edits in existing files", () => {
    const doc = fixture();
    for (const edit of [
      (text: Y.Text) => text.insert(1, "insert"),
      (text: Y.Text) => text.delete(0, text.length),
      (text: Y.Text) => {
        text.delete(0, 2);
        text.insert(0, "replacement");
      },
    ])
      expect(
        permitsUpdate(
          doc,
          change(doc, (copy) => edit(copy.getText(YDOC.fileText("main")))),
          none,
        ),
      ).toBe(true);
  });
  it("cannot disguise nested title content as text, including delete-only updates", () => {
    const doc = fixture();
    const nested = new Y.Map();
    doc.getMap(YDOC.meta).set("title", nested);
    const text = new Y.Text("secret");
    nested.set("text", text);
    for (const remove of [false, true]) {
      const update = change(doc, (copy) => {
        const value = copy.getMap<Y.Map<Y.Text>>(YDOC.meta).get("title")?.get("text");
        if (remove) value?.delete(0, 1);
        else value?.insert(0, "bypass");
      });
      expect(permitsUpdate(doc, update, none)).toBe(false);
      expect(permitsUpdate(doc, update, { ...none, rename: true })).toBe(true);
    }
  });
  it("keeps language ownership for text nested inside file language metadata", () => {
    const doc = fixture();
    doc.getMap<Y.Map<unknown>>(YDOC.files).get("main")?.set("language", new Y.Text("typescript"));
    const update = change(doc, (copy) =>
      copy.getMap<Y.Map<Y.Text>>(YDOC.files).get("main")?.get("language")?.insert(0, "nested"),
    );
    expect(permitsUpdate(doc, update, { ...none, files: true })).toBe(false);
    expect(permitsUpdate(doc, update, { ...none, language: true })).toBe(true);
  });
  it("checks newly nested types, mixed updates and all unknown root types", () => {
    const doc = fixture();
    const mixed = change(doc, (copy) => {
      copy.getText(YDOC.fileText("main")).insert(0, "allowed");
      copy.getMap(YDOC.meta).set("title", new Y.Text("forbidden"));
    });
    expect(permitsUpdate(doc, mixed, none)).toBe(false);
    expect(permitsUpdate(doc, mixed, { ...none, rename: true })).toBe(true);
    expect(
      permitsUpdate(
        doc,
        change(doc, (copy) => copy.getText("backdoor").insert(0, "x")),
        all,
      ),
    ).toBe(false);
    expect(
      permitsUpdate(
        doc,
        change(doc, (copy) => copy.getText("file:missing").insert(0, "x")),
        none,
      ),
    ).toBe(false);
  });
  it("resolves omitted parents from both origin and rightOrigin", () => {
    const doc = fixture();
    for (const at of [0, 2, 5]) {
      expect(
        permitsUpdate(
          doc,
          change(doc, (copy) => copy.getText("file:main").insert(at, "x")),
          none,
        ),
      ).toBe(true);
    }
  });
  it("refuses unresolved dependencies rather than queuing unchecked operations", () => {
    const doc = fixture();
    const copy = new Y.Doc();
    const updates: Uint8Array[] = [];
    copy.on("update", (update: Uint8Array) => updates.push(update));
    copy.getMap(YDOC.meta).set("title", new Y.Text("first"));
    copy.getMap<Y.Text>(YDOC.meta).get("title")?.insert(0, "hidden");
    expect(permitsUpdate(doc, Y.decodeUpdate(updates[1] as Uint8Array), all)).toBe(false);
    const fresh = new Y.Doc();
    const deleteUpdate = change(copy, (c) => c.getMap(YDOC.meta).delete("title"));
    expect(permitsUpdate(fresh, deleteUpdate, all)).toBe(false);
  });
  it("refuses forged origins that point across document types", () => {
    const doc = fixture();
    const update = change(doc, (copy) => copy.getText("file:main").insert(2, "x"));
    const item = update.structs.find((struct) => struct instanceof Y.Item);
    const title = doc.getMap("meta")._map.get("title");
    if (!(item instanceof Y.Item) || !title) throw new Error("missing item");
    item.rightOrigin = title.id;
    expect(permitsUpdate(doc, update, none)).toBe(false);
  });
  it("refuses a partial struct replay whose new tail changes parent", () => {
    const doc = fixture();
    doc.getMap("meta").set("title", "Last");
    const title = doc.getMap("meta")._map.get("title");
    if (!title) throw new Error("missing title");
    const forged = new Y.Item(
      title.id,
      null,
      null,
      null,
      null,
      null,
      null,
      new Y.ContentString("xx"),
    );
    Object.assign(forged, { parent: "file:main" });
    expect(permitsUpdate(doc, { structs: [forged], ds: Y.createDeleteSet() }, none)).toBe(false);
  });
  it("does not treat echoed or already deleted operations as new work", () => {
    const doc = fixture();
    doc.getMap(YDOC.meta).set("title", "Updated");
    const echoed = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
    expect(hasNewOperations(doc, echoed)).toBe(false);
    expect(permitsUpdate(doc, echoed, none)).toBe(true);
    expect(
      hasNewOperations(
        doc,
        change(doc, (copy) => copy.getText("file:main").delete(0, 1)),
      ),
    ).toBe(true);
  });
});
