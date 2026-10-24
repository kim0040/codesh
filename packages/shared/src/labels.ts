import { z } from "zod";
import { MAX_FOLDER_LENGTH, MAX_TAG_LENGTH, MAX_TAGS_PER_SHARE } from "./constants.js";

/** A person's own folder and tags for a share in "my shares" (§5 `share_labels`, §9). */

/** Visible text only: no control characters or line breaks. */
const NO_CONTROL = /^[^\p{Cc}]*$/u;

export const folderSchema = z
  .string()
  .trim()
  .max(MAX_FOLDER_LENGTH)
  .regex(NO_CONTROL)
  // An empty folder means "no folder".
  .transform((folder) => (folder === "" ? null : folder));

export const tagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH).regex(NO_CONTROL);

/** Drops later duplicates that differ only in case; the first spelling wins. */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** What is stored and returned. */
export const shareLabelsViewSchema = z.object({
  folder: z.string().nullable(),
  tags: z.array(z.string()),
});
export type ShareLabels = z.infer<typeof shareLabelsViewSchema>;

/**
 * `PUT /api/shares/:id/labels` body. An empty folder is no folder; duplicate tags (any case) are
 * dropped before the limit applies, so a client that sends one tag twice is not refused.
 */
export const putLabelsBodySchema = z.object({
  folder: z.union([z.null(), folderSchema]),
  tags: z
    .array(tagSchema)
    .max(MAX_TAGS_PER_SHARE * 2)
    .transform(dedupeTags)
    .pipe(z.array(z.string()).max(MAX_TAGS_PER_SHARE)),
});
export type PutLabelsBody = z.output<typeof putLabelsBodySchema>;
export const putLabelsResponseSchema = shareLabelsViewSchema;

export const emptyLabels = (): ShareLabels => ({ folder: null, tags: [] });

export function hasLabels(labels: ShareLabels): boolean {
  return labels.folder !== null || labels.tags.length > 0;
}
