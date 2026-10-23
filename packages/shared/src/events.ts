import { z } from "zod";
import { nearbyItemSchema, presenceUserSchema } from "./http.js";
import { clientIdSchema, labIdSchema, shareIdSchema, uploadIdSchema } from "./ids.js";
import { userRefSchema } from "./user.js";

/** SSE events of `GET /api/events` (§9.1): `event: <type>` plus JSON `data`. */

export const LAB_EVENT_KINDS = ["joined", "distributed", "locked", "unlocked"] as const;

export const sseEventSchemas = {
  presence: z.array(presenceUserSchema),
  nearby: z.array(nearbyItemSchema),
  invite: z.object({
    from: userRefSchema,
    shareId: shareIdSchema,
    title: z.string(),
    language: z.string(),
    note: z.string().optional(),
    uploadId: uploadIdSchema.optional(),
  }),
  broadcast: z.object({ from: userRefSchema, shareId: shareIdSchema, title: z.string() }),
  "approval-request": z.object({
    shareId: shareIdSchema,
    clientId: clientIdSchema,
    name: z.string(),
  }),
  "approval-result": z.object({ shareId: shareIdSchema, approved: z.boolean() }),
  kicked: z.object({ shareId: shareIdSchema, banned: z.boolean() }),
  lab: z.object({ labId: labIdSchema, kind: z.enum(LAB_EVENT_KINDS) }),
} as const;

export type SseEventType = keyof typeof sseEventSchemas;
export const SSE_EVENT_TYPES = Object.keys(sseEventSchemas) as SseEventType[];

export type SseEventData<T extends SseEventType> = z.infer<(typeof sseEventSchemas)[T]>;

export type SseEvent = {
  [T in SseEventType]: { event: T; data: SseEventData<T> };
}[SseEventType];

export const sseEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("presence"), data: sseEventSchemas.presence }),
  z.object({ event: z.literal("nearby"), data: sseEventSchemas.nearby }),
  z.object({ event: z.literal("invite"), data: sseEventSchemas.invite }),
  z.object({ event: z.literal("broadcast"), data: sseEventSchemas.broadcast }),
  z.object({ event: z.literal("approval-request"), data: sseEventSchemas["approval-request"] }),
  z.object({ event: z.literal("approval-result"), data: sseEventSchemas["approval-result"] }),
  z.object({ event: z.literal("kicked"), data: sseEventSchemas.kicked }),
  z.object({ event: z.literal("lab"), data: sseEventSchemas.lab }),
]);

/** Wire format of one SSE message. */
export function formatSseEvent(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
