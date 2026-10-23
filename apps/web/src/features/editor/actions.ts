import { strToU8, zipSync } from "fflate";
import type * as Y from "yjs";
import { type FileEntry, fileText } from "../../lib/collab/model";
import { baseName, copyText, downloadBlob } from "../../lib/format";

/** Whole-share actions that read the live Y.Doc (so they also work offline). */

export async function copyAll(doc: Y.Doc, file: FileEntry): Promise<boolean> {
  return copyText(fileText(doc, file.id).toString());
}

export function downloadFile(doc: Y.Doc, file: FileEntry): void {
  const blob = new Blob([fileText(doc, file.id).toString()], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, baseName(file.path) || "file.txt");
}

export function downloadZip(doc: Y.Doc, files: readonly FileEntry[], title: string): void {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.path] = strToU8(fileText(doc, file.id).toString());
  const zipped = zipSync(entries, { level: 6 });
  const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
  downloadBlob(blob, `${(title || "codesh").replace(/[\\/:*?"<>|]+/g, "_")}.zip`);
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
