import { languageForFilename, PLAIN_TEXT_ID } from "@gachipad/highlight";
import { MAX_FILES_PER_SHARE } from "@gachipad/shared";
import { unzipSync } from "fflate";
import type * as Y from "yjs";
import { relativePathOf } from "../../lib/api";
import {
  addFile,
  type FileEntry,
  fileText,
  renameFile,
  setFileLanguage,
  uniquePath,
} from "../../lib/collab/model";
import { baseName } from "../../lib/format";
import { isJunkFile } from "./dropped-files";

/** Reads dropped or picked files as text and puts them into the open share. */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ImportResult {
  added: number;
  skipped: number;
  /** The file the editor should show afterwards. */
  firstId: string | null;
  tooMany: boolean;
}

interface Incoming {
  path: string;
  content: string;
}

function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Text of a file as saved on any desktop: UTF-16 with a byte order mark (Windows "Unicode"),
 * UTF-8, or else the legacy Korean Windows code page. Line endings become "\n" and a leading BOM
 * goes: the editor counts "\r\n" as one character where the shared text counts two, so CRLF would
 * put everyone's edits in the wrong place.
 */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le").decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be").decode(bytes);
  else if (looksBinary(bytes)) return null;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("euc-kr").decode(bytes);
    }
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

async function expand(files: readonly File[]): Promise<{ items: Incoming[]; skipped: number }> {
  const items: Incoming[] = [];
  let skipped = 0;
  const take = (path: string, bytes: Uint8Array) => {
    if (isJunkFile(path.replace(/\\/g, "/"))) return;
    const content = bytes.length > MAX_FILE_BYTES ? null : decodeText(bytes);
    if (content === null) {
      skipped++;
      return;
    }
    // Archives made on Windows may separate folders with backslashes.
    items.push({ path: path.replace(/\\/g, "/").replace(/^\/+/, ""), content });
  };
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      try {
        const entries = unzipSync(bytes);
        for (const [path, data] of Object.entries(entries)) {
          if (/[/\\]$/.test(path)) continue;
          take(path, data);
        }
        continue;
      } catch {
        // Not a readable archive: fall through and treat it like any other file (which skips it).
      }
    }
    take(relativePathOf(file) ?? file.name, bytes);
  }
  return { items, skipped };
}

export async function importFiles(
  doc: Y.Doc,
  existing: readonly FileEntry[],
  files: readonly File[],
  options: { canChangeLanguage?: boolean | (() => boolean); mayApply?: () => boolean } = {},
): Promise<ImportResult> {
  const { items, skipped } = await expand(files);
  if (options.mayApply && !options.mayApply())
    return { added: 0, skipped: skipped + items.length, firstId: null, tooMany: false };
  let added = 0;
  let firstId: string | null = null;
  let tooMany = false;
  const known = [...existing];
  const canChangeLanguage =
    typeof options.canChangeLanguage === "function"
      ? options.canChangeLanguage()
      : options.canChangeLanguage !== false;

  // A fresh, empty share takes the first file in place instead of keeping an empty "main".
  const only = known.length === 1 ? known[0] : undefined;
  if (only && items.length > 0 && fileText(doc, only.id).length === 0) {
    const [first] = items.splice(0, 1);
    if (first) {
      renameFile(doc, only.id, first.path);
      if (canChangeLanguage)
        setFileLanguage(
          doc,
          only.id,
          languageForFilename(baseName(first.path))?.id ?? PLAIN_TEXT_ID,
        );
      fileText(doc, only.id).insert(0, first.content);
      known[0] = { ...only, path: first.path };
      firstId = only.id;
      added++;
    }
  }
  for (const item of items) {
    if (known.length >= MAX_FILES_PER_SHARE) {
      tooMany = true;
      break;
    }
    const path = uniquePath(known, item.path);
    const language = languageForFilename(baseName(path))?.id ?? PLAIN_TEXT_ID;
    const id = addFile(doc, path, language, item.content);
    known.push({ id, path, language, order: known.length });
    firstId ??= id;
    added++;
  }
  return { added, skipped, firstId, tooMany };
}
