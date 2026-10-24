import { commentSchema, YDOC } from "@codesh/shared";
import * as Y from "yjs";

/** Check before Hocuspocus applies or broadcasts the update. Text inserts need no document copy. */
export function validCommentAuthors(
  document: Y.Doc,
  update: Uint8Array,
  author: { clientId: string; name: string; color: string },
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
    const previous = new Map(
      document
        .getArray(YDOC.comments)
        .toJSON()
        .map((value: unknown) => {
          const parsed = commentSchema.safeParse(value);
          return parsed.success ? ([parsed.data.id, parsed.data] as const) : (["", null] as const);
        }),
    );
    const ids = new Set<string>();
    for (const value of projected.getArray(YDOC.comments).toJSON()) {
      const parsed = commentSchema.safeParse(value);
      if (!parsed.success || ids.has(parsed.data.id)) return false;
      ids.add(parsed.data.id);
      const original = previous.get(parsed.data.id);
      const verified = original?.author ?? author;
      if (original && original.author.clientId !== author.clientId) {
        const { resolved: _previousResolved, ...previousContent } = original;
        const { resolved: _nextResolved, ...nextContent } = parsed.data;
        if (JSON.stringify(previousContent) !== JSON.stringify(nextContent)) return false;
      }
      if (
        parsed.data.author.clientId !== verified.clientId ||
        parsed.data.author.name !== verified.name ||
        parsed.data.author.color !== verified.color
      )
        return false;
    }
    return true;
  } finally {
    projected.destroy();
  }
}
