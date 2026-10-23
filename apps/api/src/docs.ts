import { randomUUID } from "node:crypto";
import { apiChannels, apiKeys, DEFAULT_FILE_ID, generateFileId, keys, YDOC } from "@codesh/shared";
import { DuplicateSeqError } from "@codesh/storage";
import * as Y from "yjs";
import type { Ctx } from "./ctx.js";
import { firstLines, utf8Length } from "./files.js";

/** Server-side access to the Y.Doc of a share (§4): build, read, and apply changes made by the API. */

export interface NewFile {
  path: string;
  language: string;
  content: string;
}

export interface DocFile extends NewFile {
  id: string;
  order: number;
}

export interface DocContent {
  title: string;
  language: string;
  files: DocFile[];
}

export const UNTITLED_PATH = "untitled";

/** A fresh document; the first file gets the id `main`, later ones random ids (§3). */
export function buildDoc(input: { title: string; language: string; files: NewFile[] }): Y.Doc {
  const doc = new Y.Doc();
  const files =
    input.files.length > 0
      ? input.files
      : [{ path: UNTITLED_PATH, language: input.language, content: "" }];
  doc.transact(() => {
    const meta = doc.getMap<string>(YDOC.meta);
    meta.set("title", input.title);
    meta.set("language", input.language);
    const map = doc.getMap<Y.Map<unknown>>(YDOC.files);
    const used = new Set<string>();
    for (const [order, file] of files.entries()) {
      let id = DEFAULT_FILE_ID;
      if (order > 0) {
        do id = generateFileId();
        while (used.has(id));
      }
      used.add(id);
      const entry = new Y.Map<unknown>();
      map.set(id, entry);
      entry.set("path", file.path);
      entry.set("language", file.language);
      entry.set("order", order);
      doc.getText(YDOC.fileText(id)).insert(0, file.content);
    }
  });
  return doc;
}

export function readContent(doc: Y.Doc): DocContent {
  const meta = doc.getMap<unknown>(YDOC.meta);
  const files: DocFile[] = [];
  for (const [id, entry] of doc.getMap<unknown>(YDOC.files).entries()) {
    if (!(entry instanceof Y.Map)) continue;
    files.push({
      id,
      path: String(entry.get("path") ?? id),
      language: String(entry.get("language") ?? ""),
      order: Number(entry.get("order") ?? 0),
      content: doc.getText(YDOC.fileText(id)).toString(),
    });
  }
  files.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return {
    title: String(meta.get("title") ?? ""),
    language: String(meta.get("language") ?? ""),
    files,
  };
}

export const contentBytes = (content: DocContent) =>
  content.files.reduce((sum, file) => sum + utf8Length(file.content), 0);

/** The stored state: newest compact snapshot plus the updates after it (§6.4). */
export async function loadDoc(ctx: Ctx, shareId: string): Promise<Y.Doc> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await ctx.stores.snapshots.latest(shareId, "compact");
    const base = snapshot?.seq ?? 0;
    const updates = await ctx.stores.updates.read(shareId, base);
    const after = await ctx.stores.snapshots.latest(shareId, "compact");
    // A compaction between the two reads deletes updates we expected to find; read again.
    if ((after?.seq ?? 0) !== base && attempt < 3) continue;
    const doc = new Y.Doc();
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    for (const update of updates) Y.applyUpdate(doc, update.data);
    return doc;
  }
}

/** Stores a brand new document as the first snapshot (seq 0), so collab loads it like any other. */
export async function storeInitialState(ctx: Ctx, shareId: string, doc: Y.Doc): Promise<void> {
  await ctx.stores.snapshots.put({
    shareId,
    seq: 0,
    state: new Uint8Array(Y.encodeStateAsUpdate(doc)),
    at: new Date(),
    kind: "compact",
  });
}

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Appends an update as a normal entry of the update log. The next seq is above both the last
 * entry and the newest compact snapshot, because collab ignores entries at or below the snapshot.
 * While no collab instance owns the document, the API holds `doclock:<id>` so none can start
 * writing underneath it. The update is also published on `doc:<id>` for an instance that holds the
 * document in memory; applying a Yjs update twice is harmless.
 */
export async function persistUpdate(ctx: Ctx, shareId: string, update: Uint8Array): Promise<void> {
  const lockKey = keys.docLock(shareId);
  const token = `api:${randomUUID()}`;
  const locked = (await ctx.valkey.set(lockKey, token, "PX", 5000, "NX")) === "OK";
  try {
    for (let attempt = 0; ; attempt++) {
      const [last, snapshot] = await Promise.all([
        ctx.stores.updates.lastSeq(shareId),
        ctx.stores.snapshots.latest(shareId, "compact"),
      ]);
      const seq = Math.max(last, snapshot?.seq ?? 0) + 1;
      try {
        await ctx.stores.updates.append(shareId, [{ seq, data: update }], new Date());
        break;
      } catch (error) {
        if (!(error instanceof DuplicateSeqError) || attempt >= 7) throw error;
      }
    }
  } finally {
    if (locked) await ctx.valkey.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
  }
  await ctx.valkey.publish(
    apiChannels.doc(shareId),
    JSON.stringify({ update: Buffer.from(update).toString("base64") }),
  );
}

/**
 * Runs `change` on the stored document and persists what it changed as one update.
 * Returns false when nothing changed.
 */
export async function applyServerChange(
  ctx: Ctx,
  shareId: string,
  change: (doc: Y.Doc) => void,
): Promise<boolean> {
  const doc = await loadDoc(ctx, shareId);
  const before = Y.encodeStateVector(doc);
  doc.transact(() => change(doc), "api");
  const update = Y.encodeStateAsUpdate(doc, before);
  // An update that carries no structs and no deletions is the two bytes [0, 0].
  if (update.byteLength <= 2) return false;
  await persistUpdate(ctx, shareId, update);
  return true;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Turns `text` into `next` with one delete and one insert around the common prefix and suffix. */
export function replaceText(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  const limit = Math.min(current.length, next.length);
  let start = 0;
  while (start < limit && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (
    endCurrent > start &&
    endNext > start &&
    current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)
  ) {
    endCurrent--;
    endNext--;
  }
  // Never cut a surrogate pair in half.
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
    endCurrent++;
    endNext++;
  }
  if (endCurrent > start) text.delete(start, endCurrent - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
}

/** Edits `doc` so that its meta, files and file contents equal `target`. Comments are left alone. */
export function restoreInto(doc: Y.Doc, target: DocContent): void {
  const meta = doc.getMap<unknown>(YDOC.meta);
  if (meta.get("title") !== target.title) meta.set("title", target.title);
  if (meta.get("language") !== target.language) meta.set("language", target.language);

  const files = doc.getMap<unknown>(YDOC.files);
  const wanted = new Set(target.files.map((file) => file.id));
  for (const id of [...files.keys()]) {
    if (wanted.has(id)) continue;
    files.delete(id);
    const text = doc.getText(YDOC.fileText(id));
    text.delete(0, text.length);
  }
  for (const file of target.files) {
    let entry = files.get(file.id);
    if (!(entry instanceof Y.Map)) {
      entry = new Y.Map<unknown>();
      files.set(file.id, entry);
    }
    const map = entry as Y.Map<unknown>;
    if (map.get("path") !== file.path) map.set("path", file.path);
    if (map.get("language") !== file.language) map.set("language", file.language);
    if (map.get("order") !== file.order) map.set("order", file.order);
    replaceText(doc.getText(YDOC.fileText(file.id)), file.content);
  }
}

/** First lines of the main file for lists, cached briefly so a list of shares loads few documents. */
export async function sharePreview(ctx: Ctx, shareId: string): Promise<string> {
  const key = apiKeys.preview(shareId);
  const cached = await ctx.valkey.get(key);
  if (cached !== null) return cached;
  const content = readContent(await loadDoc(ctx, shareId));
  const main = content.files.find((file) => file.id === DEFAULT_FILE_ID) ?? content.files[0];
  const preview = main ? firstLines(main.content) : "";
  await ctx.valkey.set(key, preview, "EX", 60);
  return preview;
}

export function previewOf(content: DocContent): string {
  const main = content.files.find((file) => file.id === DEFAULT_FILE_ID) ?? content.files[0];
  return main ? firstLines(main.content) : "";
}
