import { YDOC } from "@codesh/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyMeta, syncContent, syncText } from "./content.js";

/** A doc and a peer that receives every update from it, like a connected client. */
function pair() {
  const doc = new Y.Doc();
  const peer = new Y.Doc();
  doc.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
  return { doc, peer };
}

const snapshot = (doc: Y.Doc) => ({
  meta: doc.getMap(YDOC.meta).toJSON(),
  files: doc.getMap(YDOC.files).toJSON(),
  main: doc.getText(YDOC.fileText("main")).toString(),
  other: doc.getText(YDOC.fileText("Other123")).toString(),
  comments: doc.getArray(YDOC.comments).toJSON(),
});

function file(path: string, language: string, order: number) {
  return new Y.Map<unknown>([
    ["path", path],
    ["language", language],
    ["order", order],
  ]);
}

describe("syncText", () => {
  it("turns any text into any other text without breaking surrogate pairs", () => {
    const unit = fc.constantFrom("a", "b", "\n", "é", "😀", "😁", "🙂");
    fc.assert(
      fc.property(
        fc.string({ unit, maxLength: 20 }),
        fc.string({ unit, maxLength: 20 }),
        (a, b) => {
          const { doc, peer } = pair();
          const text = doc.getText("t");
          text.insert(0, a);
          doc.transact(() => syncText(text, b));
          expect(text.toString()).toBe(b);
          expect(peer.getText("t").toString()).toBe(b);
        },
      ),
    );
  });

  it("only touches the changed range", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "keep this, change that, keep this");
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(...event.delta));
    doc.transact(() => syncText(text, "keep this, CHANGED, keep this"));
    expect(deltas).toEqual(
      expect.arrayContaining([{ retain: 11 }, { insert: "CHANGED" }, { delete: 11 }]),
    );
    expect(deltas).toHaveLength(3);
  });
});

describe("syncContent", () => {
  it("makes meta, files, texts and comments equal to the target", () => {
    const { doc, peer } = pair();
    doc.transact(() => {
      doc.getMap(YDOC.meta).set("title", "Live");
      doc.getMap(YDOC.meta).set("language", "go");
      doc.getMap(YDOC.files).set("main", file("main.go", "go", 0));
      doc.getMap(YDOC.files).set("Other123", file("util.go", "go", 1));
      doc.getText(YDOC.fileText("main")).insert(0, "package main\n");
      doc.getText(YDOC.fileText("Other123")).insert(0, "package util\n");
      doc.getArray(YDOC.comments).push([{ id: "c1", body: "live" }]);
    });

    const target = new Y.Doc();
    target.transact(() => {
      target.getMap(YDOC.meta).set("title", "Target");
      target.getMap(YDOC.files).set("main", file("main.ts", "typescript", 0));
      target.getText(YDOC.fileText("main")).insert(0, "export {};\n");
      target.getArray(YDOC.comments).push([{ id: "c0", body: "old" }]);
    });
    // As restore does: the target arrives as an encoded state.
    const decoded = new Y.Doc();
    Y.applyUpdate(decoded, Y.encodeStateAsUpdate(target));

    doc.transact(() => syncContent(doc, decoded));
    const expected = {
      meta: { title: "Target" },
      files: { main: { path: "main.ts", language: "typescript", order: 0 } },
      main: "export {};\n",
      other: "",
      comments: [{ id: "c0", body: "old" }],
    };
    expect(snapshot(doc)).toEqual(expected);
    expect(snapshot(peer)).toEqual(expected);
  });

  it("changes nothing when the content already matches", () => {
    const doc = new Y.Doc();
    doc.getMap(YDOC.meta).set("title", "Same");
    doc.getText(YDOC.fileText("main")).insert(0, "same");
    const target = new Y.Doc();
    Y.applyUpdate(target, Y.encodeStateAsUpdate(doc));
    let updates = 0;
    doc.on("update", () => updates++);
    doc.transact(() => syncContent(doc, target));
    expect(updates).toBe(0);
  });
});

describe("applyMeta", () => {
  it("sets the title and the default or per-file language", () => {
    const doc = new Y.Doc();
    doc.getMap(YDOC.files).set("main", file("a.ts", "typescript", 0));
    expect(applyMeta(doc, { title: "T", language: "python" })).toBe(true);
    expect(applyMeta(doc, { fileId: "main", language: "go" })).toBe(true);
    expect(doc.getMap(YDOC.meta).toJSON()).toEqual({ title: "T", language: "python" });
    expect(doc.getMap(YDOC.files).toJSON().main.language).toBe("go");
  });

  it("refuses an unknown file without changing anything", () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on("update", () => updates++);
    expect(applyMeta(doc, { title: "T", fileId: "Missing1", language: "go" })).toBe(false);
    expect(updates).toBe(0);
  });
});
