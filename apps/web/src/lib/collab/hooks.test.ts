import { YDOC } from "@codesh/shared";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { derivedStore } from "./hooks";
import { readFiles } from "./model";

function filesStore(doc: Y.Doc) {
  return derivedStore(doc, readFiles, (d) => [d.getMap(YDOC.files)]);
}

function addFile(doc: Y.Doc, id: string) {
  const entry = new Y.Map<unknown>();
  entry.set("path", `${id}.ts`);
  doc.getMap(YDOC.files).set(id, entry);
}

describe("derived store", () => {
  it("catches a change between the render and the subscription", () => {
    const doc = new Y.Doc();
    const store = filesStore(doc);
    expect(store.getSnapshot()).toEqual([]);
    // The offline copy finishes loading before React subscribes.
    addFile(doc, "main");
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().map((file) => file.id)).toEqual(["main"]);
    unsubscribe();
  });

  it("keeps the same value when nothing changed, and follows later changes", () => {
    const doc = new Y.Doc();
    addFile(doc, "main");
    const store = filesStore(doc);
    const first = store.getSnapshot();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    expect(onChange).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(first);
    addFile(doc, "second");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().map((file) => file.id)).toEqual(["main", "second"]);
    unsubscribe();
    addFile(doc, "third");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
