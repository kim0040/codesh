import { DEFAULT_FILE_ID, YDOC } from "@codesh/shared";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildDoc, contentBytes, readContent, replaceText, restoreInto } from "./docs.js";

const text = (value: string) => {
  const doc = new Y.Doc();
  const ytext = doc.getText("t");
  ytext.insert(0, value);
  return ytext;
};

describe("buildDoc / readContent", () => {
  it("round-trips meta, files and contents; the first file is `main`", () => {
    const doc = buildDoc({
      title: "Demo",
      language: "typescript",
      files: [
        { path: "src/index.ts", language: "typescript", content: "export {};\n" },
        { path: "README.md", language: "markdown", content: "# Hi" },
      ],
    });
    const content = readContent(doc);
    expect(content.title).toBe("Demo");
    expect(content.language).toBe("typescript");
    expect(content.files.map((f) => f.path)).toEqual(["src/index.ts", "README.md"]);
    expect(content.files[0]?.id).toBe(DEFAULT_FILE_ID);
    expect(content.files[1]?.id).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(content.files.map((f) => f.content)).toEqual(["export {};\n", "# Hi"]);
    expect(doc.getText(YDOC.fileText(DEFAULT_FILE_ID)).toString()).toBe("export {};\n");
  });

  it("creates one empty main file when no file is given", () => {
    const content = readContent(buildDoc({ title: "", language: "plaintext", files: [] }));
    expect(content.files).toHaveLength(1);
    expect(content.files[0]).toMatchObject({ id: DEFAULT_FILE_ID, content: "" });
  });

  it("survives encoding the state and loading it into a fresh document", () => {
    const original = buildDoc({
      title: "t",
      language: "go",
      files: [{ path: "a.go", language: "go", content: "package main" }],
    });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(original));
    expect(readContent(copy)).toEqual(readContent(original));
    expect(contentBytes(readContent(copy))).toBe(Buffer.byteLength("package main"));
  });
});

describe("replaceText", () => {
  const cases: [string, string][] = [
    ["hello world", "hello brave new world"],
    ["abc", ""],
    ["", "abc"],
    ["same", "same"],
    ["line1\nline2\nline3", "line1\nCHANGED\nline3"],
    ["aaaa", "aa"],
    ["abab", "ababab"],
    ["안녕하세요", "안녕 세계"],
    ["x😀y", "x😁y"],
    ["😀😀", "😀"],
  ];
  for (const [from, to] of cases) {
    it(`turns ${JSON.stringify(from)} into ${JSON.stringify(to)}`, () => {
      const ytext = text(from);
      replaceText(ytext, to);
      expect(ytext.toString()).toBe(to);
    });
  }

  it("changes only the differing middle, so concurrent edits around it survive", () => {
    const base = buildDoc({
      title: "",
      language: "plaintext",
      files: [{ path: "a", language: "plaintext", content: "head MIDDLE tail" }],
    });
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
    // Someone else types at the end while the API rewrites the middle.
    other.getText(YDOC.fileText(DEFAULT_FILE_ID)).insert(16, "!");
    replaceText(base.getText(YDOC.fileText(DEFAULT_FILE_ID)), "head NEW tail");
    Y.applyUpdate(base, Y.encodeStateAsUpdate(other));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
    const merged = base.getText(YDOC.fileText(DEFAULT_FILE_ID)).toString();
    expect(merged).toBe("head NEW tail!");
    expect(other.getText(YDOC.fileText(DEFAULT_FILE_ID)).toString()).toBe(merged);
  });
});

describe("restoreInto", () => {
  it("rewrites meta, files and contents to match the target and emits a normal update", () => {
    const past = buildDoc({
      title: "Old",
      language: "python",
      files: [
        { path: "main.py", language: "python", content: "print(1)\n" },
        { path: "util.py", language: "python", content: "x = 1\n" },
      ],
    });
    const pastContent = readContent(past);

    const current = new Y.Doc();
    Y.applyUpdate(current, Y.encodeStateAsUpdate(past));
    current.transact(() => {
      current.getMap(YDOC.meta).set("title", "New");
      current.getText(YDOC.fileText(DEFAULT_FILE_ID)).insert(0, "# edited\n");
      (current.getMap(YDOC.files).get(pastContent.files[1]?.id as string) as Y.Map<unknown>).set(
        "order",
        5,
      );
      current.getMap(YDOC.files).delete(pastContent.files[1]?.id as string);
      current.getMap(YDOC.files).set("zzzzzzzz", new Y.Map([["path", "extra.py"]]));
    });
    expect(readContent(current).title).toBe("New");

    // A client that saw the state before the restore applies the restore like any other update.
    const watcher = new Y.Doc();
    Y.applyUpdate(watcher, Y.encodeStateAsUpdate(current));
    const sinceRestore = Y.encodeStateVector(watcher);
    current.transact(() => restoreInto(current, pastContent));
    Y.applyUpdate(watcher, Y.encodeStateAsUpdate(current, sinceRestore));

    for (const doc of [current, watcher]) {
      const restored = readContent(doc);
      expect(restored.title).toBe("Old");
      expect(restored.language).toBe("python");
      expect(restored.files.map((f) => [f.id, f.path, f.content])).toEqual(
        pastContent.files.map((f) => [f.id, f.path, f.content]),
      );
    }
  });
});
