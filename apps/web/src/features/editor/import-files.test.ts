import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readFiles, setFileLanguage } from "../../lib/collab/model";
import { isJunkFile } from "./dropped-files";
import { decodeText, importFiles } from "./import-files";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("decodeText", () => {
  it("turns Windows line endings into \\n and drops a byte order mark", () => {
    const text = new TextEncoder().encode("﻿a\r\nb\rc\n");
    expect(decodeText(text)).toBe("a\nb\nc\n");
  });

  it("reads UTF-16 files saved as Unicode on Windows", () => {
    // BOM, "h", "i", CR, LF in UTF-16LE.
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0, 0x0d, 0, 0x0a, 0))).toBe("hi\n");
  });

  it("falls back to the Korean Windows code page when the bytes are not UTF-8", () => {
    // "한글" in EUC-KR / CP949.
    expect(decodeText(bytes(0xc7, 0xd1, 0xb1, 0xdb))).toBe("한글");
  });

  it("skips binary files", () => {
    expect(decodeText(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00))).toBeNull();
  });
});

describe("isJunkFile", () => {
  it("recognises what Finder, Explorer and Office leave behind", () => {
    for (const path of [
      ".DS_Store",
      "src/.DS_Store",
      "Thumbs.db",
      "desktop.ini",
      "src/._main.c",
      "~$report.docx",
      "__MACOSX/src/._main.c",
    ]) {
      expect(isJunkFile(path), path).toBe(true);
    }
  });

  it("keeps real files, including dot files people write", () => {
    for (const path of [".gitignore", "src/main.ts", "docs/desktop-notes.md", "a._b"]) {
      expect(isJunkFile(path), path).toBe(false);
    }
  });
});

describe("import permissions", () => {
  function emptyShare() {
    const doc = new Y.Doc();
    const file = new Y.Map();
    doc.getMap("files").set("main", file);
    file.set("path", "main.txt");
    file.set("order", 0);
    setFileLanguage(doc, "main", "text");
    return doc;
  }
  it("keeps an existing file language when only file management is allowed", async () => {
    const doc = emptyShare();
    const result = await importFiles(doc, readFiles(doc), [new File(["print(1)"], "new.py")], {
      canChangeLanguage: false,
    });
    expect(result.added).toBe(1);
    expect(readFiles(doc)[0]).toMatchObject({ path: "new.py", language: "text" });
    expect(doc.getMap("meta").get("language")).toBe("text");
  });
  it("does not apply an import if permission was revoked while reading files", async () => {
    const doc = emptyShare();
    const result = await importFiles(doc, readFiles(doc), [new File(["print(1)"], "new.py")], {
      mayApply: () => false,
    });
    expect(result.added).toBe(0);
    expect(readFiles(doc)[0]?.path).toBe("main.txt");
    expect(doc.getText("file:main").toString()).toBe("");
  });
});
