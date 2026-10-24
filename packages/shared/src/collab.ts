import { languageSchema, roleSchema, titleSchema } from "./http.js";
import { fileIdSchema } from "./ids.js";
import { z } from "./zod.js";

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
  /**
   * MongoDB or Valkey failed while checking access or loading the document. Not a decision about
   * access: the editor should connect again with backoff.
   */
  unavailable: "unavailable",
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

/** `error` of a failed command reply on `cmd-reply:<requestId>` (§6.11). */
export const COLLAB_COMMAND_ERRORS = {
  /** The message did not match `collabCommandSchema`, or `state` is not a Yjs update. */
  invalid: "invalid",
  /** The share does not exist or is being deleted. */
  notFound: "not_found",
  /** No history snapshot with the requested `seq`. */
  snapshotNotFound: "snapshot_not_found",
  /** `meta` with a `fileId` that is not in Y.Map `files`. */
  fileNotFound: "file_not_found",
  /** The resulting document would exceed `settings.maxDocBytes`. */
  tooLarge: "too_large",
  failed: "failed",
} as const;
export type CollabCommandError = (typeof COLLAB_COMMAND_ERRORS)[keyof typeof COLLAB_COMMAND_ERRORS];

export const collabCommandRequestIdSchema = z.string().min(1).max(128);

/**
 * Message on the Valkey channel `cmd:<shareId>`: how other services change document content
 * (§6.11). `restore` brings back history snapshot `seq`; `replace` makes the document equal to a
 * full Y state (`Y.encodeStateAsUpdate`, base64); `meta` sets the title and the default language,
 * or with `fileId` that file's language. All are applied as a normal edit, so connected clients
 * see the change and history keeps growing.
 */
export const collabCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    requestId: collabCommandRequestIdSchema,
    kind: z.literal("restore"),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    requestId: collabCommandRequestIdSchema,
    kind: z.literal("replace"),
    state: z.base64(),
  }),
  z.object({
    requestId: collabCommandRequestIdSchema,
    kind: z.literal("meta"),
    title: titleSchema.optional(),
    language: languageSchema.optional(),
    fileId: fileIdSchema.optional(),
  }),
]);
export type CollabCommand = z.infer<typeof collabCommandSchema>;

/** Reply on `cmd-reply:<requestId>`, sent within `COLLAB_COMMAND_TIMEOUT_MS`. */
export const collabCommandReplySchema = z.object({
  ok: z.boolean(),
  error: z.enum(COLLAB_COMMAND_ERRORS).optional(),
});
export type CollabCommandReply = z.infer<typeof collabCommandReplySchema>;
