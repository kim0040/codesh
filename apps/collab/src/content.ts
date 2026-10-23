import { YDOC } from "@codesh/shared";
import * as Y from "yjs";

/**
 * Content changes requested over `cmd:<shareId>` (§6.11), written as ordinary edits.
 *
 * A Yjs state cannot be "rolled back" by merging an older one, so `syncContent` compares the
 * content of the live doc with a target doc and applies the inserts and deletes that turn one into
 * the other. Edits are kept small (common prefix and suffix are left alone) so cursors and
 * concurrent typing outside the changed range survive.
 */

const FILE_TEXT_PREFIX = YDOC.fileText("");

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const json = (value: unknown) => (value instanceof Y.AbstractType ? value.toJSON() : value);

/** A value of `target` ready to be inserted into another doc. */
const copy = (value: unknown) => (value instanceof Y.AbstractType ? value.clone() : value);

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Lengths of the common prefix and suffix of two sequences; they never overlap. */
function commonEnds<T>(a: ArrayLike<T>, b: ArrayLike<T>, eq: (x: T, y: T) => boolean) {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && eq(a[prefix] as T, b[prefix] as T)) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    eq(a[a.length - 1 - suffix] as T, b[b.length - 1 - suffix] as T)
  ) {
    suffix++;
  }
  return { prefix, suffix };
}

export function syncText(live: Y.Text, target: string) {
  const current = live.toString();
  if (current === target) return;
  let { prefix, suffix } = commonEnds(current, target, (x, y) => x === y);
  // Never split a surrogate pair: Yjs would replace the halves with U+FFFD.
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;
  const removed = current.length - prefix - suffix;
  if (removed > 0) live.delete(prefix, removed);
  const inserted = target.slice(prefix, target.length - suffix);
  if (inserted) live.insert(prefix, inserted);
}

export function syncArray(live: Y.Array<unknown>, target: Y.Array<unknown>) {
  const current = live.toArray().map(json);
  const wanted = target.toArray();
  const { prefix, suffix } = commonEnds(current, wanted.map(json), same);
  const removed = current.length - prefix - suffix;
  if (removed > 0) live.delete(prefix, removed);
  const inserted = wanted.slice(prefix, wanted.length - suffix);
  if (inserted.length > 0) live.insert(prefix, inserted.map(copy));
}

export function syncMap(live: Y.Map<unknown>, target: Y.Map<unknown>) {
  for (const key of [...live.keys()]) {
    if (!target.has(key)) live.delete(key);
  }
  for (const [key, value] of target.entries()) {
    const current = live.get(key);
    if (value instanceof Y.Map && current instanceof Y.Map) syncMap(current, value);
    else if (value instanceof Y.Text && current instanceof Y.Text)
      syncText(current, value.toString());
    else if (value instanceof Y.Array && current instanceof Y.Array) syncArray(current, value);
    else if (!live.has(key) || !same(json(current), json(value))) live.set(key, copy(value));
  }
}

/** Makes the content of `live` equal to `target` (§4 document model). Call inside a transaction. */
export function syncContent(live: Y.Doc, target: Y.Doc) {
  syncMap(live.getMap(YDOC.meta), target.getMap(YDOC.meta));
  syncMap(live.getMap(YDOC.files), target.getMap(YDOC.files));
  const texts = new Set(
    [...live.share.keys(), ...target.share.keys()].filter((n) => n.startsWith(FILE_TEXT_PREFIX)),
  );
  for (const name of texts) {
    const wanted = target.share.has(name) ? target.getText(name).toString() : "";
    if (wanted === "" && !live.share.has(name)) continue;
    syncText(live.getText(name), wanted);
  }
  syncArray(live.getArray(YDOC.comments), target.getArray(YDOC.comments));
}

export interface MetaChange {
  title?: string;
  language?: string;
  fileId?: string;
}

/** False when `fileId` names no file. Call inside a transaction. */
export function applyMeta(doc: Y.Doc, change: MetaChange): boolean {
  const file = change.fileId === undefined ? undefined : doc.getMap(YDOC.files).get(change.fileId);
  if (change.fileId !== undefined && !(file instanceof Y.Map)) return false;
  const meta = doc.getMap(YDOC.meta);
  if (change.title !== undefined) meta.set("title", change.title);
  if (change.language !== undefined) {
    if (file instanceof Y.Map) file.set("language", change.language);
    else meta.set("language", change.language);
  }
  return true;
}
