import { type ParticipantPermissions, YDOC } from "@gachipad/shared";
import * as Y from "yjs";

export type DecodedUpdate = ReturnType<typeof Y.decodeUpdate>;
type Struct = DecodedUpdate["structs"][number];
type Location = { root: string; keys: (string | null)[]; container?: Y.Item };
const rootNames = new WeakMap<object, string>();

/** SyncStep2 often just echoes known state, including to a read-only connection. */
export function hasNewOperations(doc: Y.Doc, decoded: DecodedUpdate): boolean {
  if (
    decoded.structs.some(
      (item) => item.id.clock + item.length > Y.getState(doc.store, item.id.client),
    )
  )
    return true;
  for (const [client, ranges] of decoded.ds.clients) {
    const items = doc.store.clients.get(client);
    for (const range of ranges) {
      if (!items || range.clock + range.len > Y.getState(doc.store, client)) return true;
      for (let i = Y.findIndexSS(items, range.clock); i < items.length; i++) {
        const item = items[i];
        if (!item || item.id.clock >= range.clock + range.len) break;
        if (item instanceof Y.Item && !item.deleted) return true;
      }
    }
  }
  return false;
}

/**
 * Classifies operations without applying them, copying the document or reading text content.
 * Parent IDs and omitted parents (inherited from origin/rightOrigin) are resolved against both
 * this update and the live store. Delete ranges are checked item by item, including nested types.
 * Unknown dependencies are refused: queuing them would let a later update apply unchecked work.
 */
export function permitsUpdate(
  doc: Y.Doc,
  decoded: DecodedUpdate,
  permissions: ParticipantPermissions,
): boolean {
  const incoming = new Map<number, Struct[]>();
  for (const item of decoded.structs) {
    const list = incoming.get(item.id.client) ?? [];
    list.push(item);
    incoming.set(item.id.client, list);
  }
  const find = (items: Struct[] | undefined, clock: number): Struct | undefined => {
    if (!items?.length) return undefined;
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const item = items[mid];
      if (!item) return undefined;
      if (clock < item.id.clock) high = mid - 1;
      else if (clock >= item.id.clock + item.length) low = mid + 1;
      else return item;
    }
    return undefined;
  };
  const lookup = (id: Y.ID): Struct | undefined =>
    find(doc.store.clients.get(id.client), id.clock) ?? find(incoming.get(id.client), id.clock);
  const locations = new Map<Y.Item, Location | null>();
  const resolving = new Set<Y.Item>();
  const location = (item: Y.Item, depth = 0): Location | null => {
    if (locations.has(item)) return locations.get(item) ?? null;
    if (depth > 64 || resolving.has(item)) return null;
    resolving.add(item);
    let result: Location | null = null;
    const parent = item.parent;
    if (typeof parent === "string") {
      result = { root: parent, keys: [item.parentSub] };
    } else if (parent instanceof Y.AbstractType) {
      if (parent._item) {
        const above = location(parent._item, depth + 1);
        if (above)
          result = {
            root: above.root,
            keys: [...above.keys, item.parentSub],
            container:
              above.root === YDOC.files && above.keys.length > 1 ? above.container : parent._item,
          };
      } else {
        let root = rootNames.get(parent);
        if (root === undefined) {
          for (const [name, type] of doc.share) {
            if (type === parent) {
              root = name;
              rootNames.set(parent, name);
              break;
            }
          }
        }
        if (root !== undefined) result = { root, keys: [item.parentSub] };
      }
    } else if (parent instanceof Y.ID) {
      const parentItem = lookup(parent);
      if (parentItem instanceof Y.Item && parentItem.content instanceof Y.ContentType) {
        const above = location(parentItem, depth + 1);
        if (above)
          result = {
            root: above.root,
            keys: [...above.keys, item.parentSub],
            container:
              above.root === YDOC.files && above.keys.length > 1 ? above.container : parentItem,
          };
      }
    } else {
      const sibling = item.origin
        ? lookup(item.origin)
        : item.rightOrigin
          ? lookup(item.rightOrigin)
          : undefined;
      if (sibling instanceof Y.Item) result = location(sibling, depth + 1);
    }
    resolving.delete(item);
    locations.set(item, result);
    return result;
  };
  const allowed = (item: Y.Item): boolean => {
    const at = location(item);
    if (!at) return false;
    if (at.root === YDOC.meta) {
      if (at.keys[0] === "title") return permissions.rename;
      if (at.keys[0] === "language") return permissions.language;
      return false;
    }
    if (at.root === YDOC.files) {
      // Adding/replacing/deleting a file entry is structural, even if it contains only language.
      if (at.keys.length >= 2 && at.keys[1] === "language") {
        const initializing =
          at.container !== undefined &&
          at.container.id.clock >= Y.getState(doc.store, at.container.id.client);
        const removingFile = at.container !== undefined && Y.isDeleted(decoded.ds, at.container.id);
        return permissions.language || (permissions.files && (initializing || removingFile));
      }
      return permissions.files;
    }
    if (at.root === YDOC.comments) return true; // attribution is checked separately
    if (at.root.startsWith(YDOC.fileText(""))) {
      // A deleted file can still have in-flight/offline text edits. The files map gates visibility.
      return (
        at.keys.length === 1 &&
        at.keys[0] === null &&
        (item.content instanceof Y.ContentString || item.content instanceof Y.ContentDeleted)
      );
    }
    return false;
  };
  const sameLocation = (a: Location | null, b: Location | null) =>
    a !== null &&
    b !== null &&
    a.root === b.root &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, i) => key === b.keys[i]);

  for (const [client, items] of incoming) {
    let clock = Y.getState(doc.store, client);
    for (const item of items) {
      const end = item.id.clock + item.length;
      if (end <= clock) continue; // already integrated; it cannot change the document
      if (item.id.clock > clock || item instanceof Y.Skip) return false;
      if (item instanceof Y.Item && item.id.clock < clock) {
        const previous = lookup(Y.createID(client, clock - 1));
        if (!(previous instanceof Y.Item) || !sameLocation(location(item), location(previous)))
          return false;
      }
      for (const id of item instanceof Y.Item ? [item.origin, item.rightOrigin] : []) {
        if (id) {
          const sibling = lookup(id);
          if (
            !(sibling instanceof Y.Item) ||
            !(item instanceof Y.Item) ||
            !sameLocation(location(item), location(sibling))
          )
            return false;
        }
      }
      if (item instanceof Y.Item && !allowed(item)) return false;
      clock = end;
    }
  }
  for (const [client, ranges] of decoded.ds.clients) {
    for (const range of ranges) {
      const end = range.clock + range.len;
      let clock = range.clock;
      while (clock < end) {
        const item = lookup(Y.createID(client, clock));
        if (!item || item instanceof Y.Skip) return false;
        if (item instanceof Y.Item && !item.deleted && !allowed(item)) return false;
        clock = item.id.clock + item.length;
      }
    }
  }
  return true;
}
