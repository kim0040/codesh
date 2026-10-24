import { type Comment, commentSchema, YDOC } from "@codesh/shared";
import * as Y from "yjs";

/**
 * Check before Hocuspocus applies or broadcasts the update. Text inserts need no document copy.
 * Only the author's clientId is verified: name and colour are chosen by each user (and the web
 * client shows a localized guest name), so they prove nothing. Comments the update leaves as they
 * were are not checked again, so an old or malformed comment cannot block every later update.
 */
export function validCommentAuthors(
  document: Y.Doc,
  update: Uint8Array,
  author: { clientId: string },
): boolean {
  const decoded = Y.decodeUpdate(update);
  if (
    decoded.structs.every(
      (item) =>
        !(item instanceof Y.Item) ||
        item.content instanceof Y.ContentString ||
        item.content instanceof Y.ContentDeleted,
    )
  )
    return true;
  const projected = new Y.Doc();
  try {
    Y.applyUpdate(projected, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(projected, update);
    if (projected.store.pendingStructs || projected.store.pendingDs) return false;
    const before = new Map<string, { raw: string; comment: Comment | null }>();
    for (const value of document.getArray(YDOC.comments).toJSON()) {
      const id = (value as { id?: unknown } | null)?.id;
      if (typeof id !== "string") continue;
      const parsed = commentSchema.safeParse(value);
      before.set(id, { raw: JSON.stringify(value), comment: parsed.success ? parsed.data : null });
    }
    const ids = new Set<string>();
    for (const value of projected.getArray(YDOC.comments).toJSON()) {
      const id = (value as { id?: unknown } | null)?.id;
      const original = typeof id === "string" ? before.get(id) : undefined;
      if (original && original.raw === JSON.stringify(value)) continue;
      const parsed = commentSchema.safeParse(value);
      if (!parsed.success || ids.has(parsed.data.id)) return false;
      ids.add(parsed.data.id);
      const previous = original?.comment ?? null;
      if (previous && previous.author.clientId !== author.clientId) {
        // Someone else's comment may only be resolved or reopened.
        const { resolved: _previousResolved, ...previousContent } = previous;
        const { resolved: _nextResolved, ...nextContent } = parsed.data;
        if (JSON.stringify(previousContent) !== JSON.stringify(nextContent)) return false;
        continue;
      }
      if (parsed.data.author.clientId !== author.clientId) return false;
    }
    return true;
  } finally {
    projected.destroy();
  }
}
