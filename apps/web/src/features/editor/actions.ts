import { strToU8, zipSync } from "fflate";
import type * as Y from "yjs";
import { type FileEntry, fileText } from "../../lib/collab/model";
import { baseName, copyText, downloadBlob, safeFileName, safeFilePath } from "../../lib/format";

/** Whole-share actions that read the live Y.Doc (so they also work offline). */

export async function copyAll(doc: Y.Doc, file: FileEntry): Promise<boolean> {
  return copyText(fileText(doc, file.id).toString());
}

export function downloadFile(doc: Y.Doc, file: FileEntry): void {
  const blob = new Blob([fileText(doc, file.id).toString()], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, safeFileName(baseName(file.path)));
}

/** "src/a.ts" -> "src/a (2).ts" */
function numbered(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0, cut)} (${n})${path.slice(cut)}`;
}

/**
 * Archive paths that unpack on any desktop. Paths Windows would treat as the same file (they differ
 * in case, or in characters it cannot store) are numbered instead of overwriting each other.
 */
export function zipEntryNames(paths: readonly string[]): string[] {
  const taken = new Set<string>();
  return paths.map((original) => {
    const path = safeFilePath(original);
    let unique = path;
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = numbered(path, n);
    taken.add(unique.toLowerCase());
    return unique;
  });
}

export function downloadZip(doc: Y.Doc, files: readonly FileEntry[], title: string): void {
  const names = zipEntryNames(files.map((file) => file.path));
  const entries: Record<string, Uint8Array> = {};
  files.forEach((file, index) => {
    entries[names[index] ?? file.path] = strToU8(fileText(doc, file.id).toString());
  });
  const zipped = zipSync(entries, { level: 6 });
  const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
  downloadBlob(blob, `${safeFileName(title, "codesh")}.zip`);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];

/** A cheap check on pasted text for things that look like credentials. */
export function looksLikeSecret(text: string): boolean {
  if (text.length < 8 || text.length > 200_000) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
