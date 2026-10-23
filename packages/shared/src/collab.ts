import { z } from "zod";
import { roleSchema } from "./http.js";

/** Messages between apps/collab and the editor beyond the Yjs protocol (§6.7, §6.8). */

/** `reason` of a per-document close; the provider reports it in `onClose`. */
export const COLLAB_CLOSE_REASONS = {
  /** The owner kicked this client. */
  kicked: "kicked",
  /** Access changed in a way only a fresh token can express: call `POST /api/shares/:id/join` again. */
  reauth: "reauth",
  deleted: "deleted",
} as const;
export type CollabCloseReason = (typeof COLLAB_CLOSE_REASONS)[keyof typeof COLLAB_CLOSE_REASONS];

/** `reason` of a refused authentication (`onAuthenticationFailed`). */
export const COLLAB_DENY_REASONS = {
  unauthorized: "unauthorized",
  notFound: "not_found",
  banned: "banned",
} as const;
export type CollabDenyReason = (typeof COLLAB_DENY_REASONS)[keyof typeof COLLAB_DENY_REASONS];

/**
 * JSON payload of stateless messages the collab server sends to one connection.
 *
 * A refused update (`too_large`, or typing while read-only) stays in the client's Y.Doc, and Yjs
 * cannot apply that client's later updates without it. After a refusal the editor must drop its
 * Y.Doc and resync with a new one, and it should block input while `readOnly` is true.
 */
export const collabStatelessSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("role"), role: roleSchema, readOnly: z.boolean() }),
  z.object({ type: z.literal("locked"), locked: z.boolean(), readOnly: z.boolean() }),
  /** An update was refused because the document would exceed `settings.maxDocBytes`. */
  z.object({ type: z.literal("too_large"), maxDocBytes: z.number().int().positive() }),
]);
export type CollabStateless = z.infer<typeof collabStatelessSchema>;
