import { z } from "zod";
import { roleSchema } from "./http.js";
import { clientIdSchema, shareIdSchema } from "./ids.js";
import { colorSchema } from "./user.js";

/** Payload signed into the collab token (§8). `exp` is Unix seconds. */
export const collabTokenPayloadSchema = z.object({
  shareId: shareIdSchema,
  clientId: clientIdSchema,
  name: z.string(),
  color: colorSchema,
  role: roleSchema,
  exp: z.number().int(),
});
export type CollabTokenPayload = z.infer<typeof collabTokenPayloadSchema>;

/** Message on the Valkey channel `perm:<shareId>` (§6.7). */
export const permMessageSchema = z.object({
  version: z.number().int().nonnegative(),
  kind: z.enum(["role", "kick", "lock", "delete"]),
  clientId: clientIdSchema.optional(),
  /** With `kind: 'role'` and `clientId`: the new role. Without it, collab asks the client to rejoin. */
  role: roleSchema.optional(),
});
export type PermMessage = z.infer<typeof permMessageSchema>;
