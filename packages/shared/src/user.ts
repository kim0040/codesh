import { z } from "zod";
import { MAX_NAME_LENGTH } from "./constants.js";
import { clientIdSchema } from "./ids.js";

export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb");
export const displayNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

/** A participant as other participants see them (awareness, invites, comments). */
export const userRefSchema = z.object({
  clientId: clientIdSchema,
  name: z.string(),
  color: colorSchema,
});
export type UserRef = z.infer<typeof userRefSchema>;
