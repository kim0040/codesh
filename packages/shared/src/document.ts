import { z } from "zod";
import { MAX_PATH_LENGTH } from "./constants.js";
import { fileIdSchema } from "./ids.js";
import { userRefSchema } from "./user.js";

/** Names of the shared types inside one Y.Doc (§4). */
export const YDOC = {
  meta: "meta",
  files: "files",
  comments: "comments",
  fileText: (fileId: string) => `file:${fileId}` as const,
} as const;

const yIdSchema = z.object({ client: z.number().int(), clock: z.number().int() });

/** `Y.RelativePosition` as produced by `relativePositionToJSON`; null fields are omitted. */
export const relativePositionSchema = z.object({
  type: yIdSchema.optional(),
  tname: z.string().optional(),
  item: yIdSchema.optional(),
  assoc: z.number().optional(),
});
export type RelativePositionJSON = z.infer<typeof relativePositionSchema>;

export const docMetaSchema = z.object({
  title: z.string(),
  language: z.string(),
});
export type DocMeta = z.infer<typeof docMetaSchema>;

export const fileMetaSchema = z.object({
  path: z.string().max(MAX_PATH_LENGTH),
  language: z.string(),
  order: z.number(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

export const commentSchema = z.object({
  id: z.string(),
  fileId: fileIdSchema,
  anchor: relativePositionSchema,
  head: relativePositionSchema,
  author: userRefSchema,
  body: z.string(),
  createdAt: z.number(),
  resolved: z.boolean(),
});
export type Comment = z.infer<typeof commentSchema>;

export const awarenessStateSchema = z.object({
  user: userRefSchema,
  fileId: fileIdSchema,
  cursor: z.object({ anchor: relativePositionSchema, head: relativePositionSchema }).optional(),
  viewport: z.object({ fromLine: z.number().int(), toLine: z.number().int() }).optional(),
  following: userRefSchema.shape.clientId.optional(),
});
export type AwarenessState = z.infer<typeof awarenessStateSchema>;
