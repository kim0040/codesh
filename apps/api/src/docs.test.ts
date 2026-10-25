import { DEFAULT_FILE_ID, YDOC } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { buildDoc, contentBytes, readContent } from "./docs.js";

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
