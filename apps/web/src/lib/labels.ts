import type { ShareListItem } from "@gachipad/shared";

/** Folders and tags of "my shares": grouping, filtering and suggestions (no React). */

type Labelled = Pick<ShareListItem, "folder" | "tags">;

/** Folders and tags are compared without regard to case; the first spelling is the one shown. */
export const labelKey = (name: string): string => name.trim().toLocaleLowerCase();

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export interface FolderEntry {
  key: string;
  name: string;
  count: number;
}

export interface TagEntry {
  key: string;
  name: string;
  count: number;
}

export function listFolders(shares: readonly Labelled[]): {
  folders: FolderEntry[];
  unfiled: number;
} {
  const folders = new Map<string, FolderEntry>();
  let unfiled = 0;
  for (const share of shares) {
    if (!share.folder) {
      unfiled++;
      continue;
    }
    const key = labelKey(share.folder);
    const entry = folders.get(key);
    if (entry) entry.count++;
    else folders.set(key, { key, name: share.folder, count: 1 });
  }
  return { folders: [...folders.values()].sort(byName), unfiled };
}

export function listTags(shares: readonly Labelled[]): TagEntry[] {
  const tags = new Map<string, TagEntry>();
  for (const share of shares) {
    for (const tag of share.tags) {
      const key = labelKey(tag);
      const entry = tags.get(key);
      if (entry) entry.count++;
      else tags.set(key, { key, name: tag, count: 1 });
    }
  }
  return [...tags.values()].sort(byName);
}

export type FolderFilter = { kind: "all" } | { kind: "none" } | { kind: "folder"; key: string };

export const ALL_FOLDERS: FolderFilter = { kind: "all" };

/** A share matches when it is in the folder and carries every selected tag (keys from `labelKey`). */
export function matchesLabels(
  share: Labelled,
  folder: FolderFilter,
  tagKeys: readonly string[],
): boolean {
  if (folder.kind === "none" && share.folder) return false;
  if (folder.kind === "folder" && (!share.folder || labelKey(share.folder) !== folder.key)) {
    return false;
  }
  if (tagKeys.length === 0) return true;
  const own = new Set(share.tags.map(labelKey));
  return tagKeys.every((key) => own.has(key));
}

/** Search box of "my shares": the text is in the title, the code, the folder or one of the tags. */
export function matchesQuery(
  share: Labelled & Pick<ShareListItem, "id" | "title">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    share.title.toLowerCase().includes(q) ||
    share.id.toLowerCase().includes(q) ||
    (share.folder?.toLowerCase().includes(q) ?? false) ||
    share.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

/** A filter that no longer points at anything (its last share moved away) falls back to "all". */
export function pruneFilters(
  folder: FolderFilter,
  tagKeys: readonly string[],
  shares: readonly Labelled[],
): { folder: FolderFilter; tags: string[] } {
  const { folders, unfiled } = listFolders(shares);
  const known = new Set(listTags(shares).map((tag) => tag.key));
  const folderGone =
    (folder.kind === "folder" && !folders.some((entry) => entry.key === folder.key)) ||
    (folder.kind === "none" && unfiled === 0);
  return {
    folder: folderGone ? ALL_FOLDERS : folder,
    tags: tagKeys.filter((key) => known.has(key)),
  };
}

/** Existing folders whose name contains the typed text, best (prefix) matches first. */
export function suggestFolders(folders: readonly FolderEntry[], typed: string): FolderEntry[] {
  const needle = labelKey(typed);
  if (!needle) return [...folders];
  const prefix = folders.filter((folder) => folder.key.startsWith(needle));
  const inside = folders.filter(
    (folder) => !folder.key.startsWith(needle) && folder.key.includes(needle),
  );
  return [...prefix, ...inside];
}

/** The spelling an existing folder already uses, so "work" does not start a second "Work". */
export function resolveFolderName(typed: string, folders: readonly FolderEntry[]): string {
  const name = typed.trim();
  return folders.find((folder) => folder.key === labelKey(name))?.name ?? name;
}

/** Tags not chosen yet whose name contains the typed text, most used first. */
export function suggestTags(
  all: readonly TagEntry[],
  chosen: readonly string[],
  typed: string,
): TagEntry[] {
  const taken = new Set(chosen.map(labelKey));
  const needle = labelKey(typed);
  return all
    .filter((tag) => !taken.has(tag.key) && (!needle || tag.key.includes(needle)))
    .sort((a, b) => b.count - a.count || byName(a, b));
}
