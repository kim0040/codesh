import { ACCESS_LEVELS } from "./constants.js";
import { clientIdSchema, joinCodeSchema, shareIdSchema, uploadIdSchema } from "./ids.js";
import { participantPermissionFields } from "./permissions.js";
import { z } from "./zod.js";

/**
 * Domain shapes of the MongoDB collections (§5). They use `id` instead of Mongo's `_id`;
 * the MongoDB implementation maps between the two.
 */

const binarySchema = z.instanceof(Uint8Array);

export const accessSchema = z.object({
  default: z.enum(ACCESS_LEVELS),
  editKey: z.string(),
  /** Persistent collab-token generation; absent on shares created before permission revocation. */
  generation: z.string().optional(),
  pinHash: z.string().nullable(),
  requireApproval: z.boolean(),
  nearby: z.boolean(),
  ...participantPermissionFields,
});
export type Access = z.infer<typeof accessSchema>;

export const shareRecordSchema = z.object({
  id: shareIdSchema,
  title: z.string(),
  language: z.string(),
  ownerId: clientIdSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  lastActiveAt: z.date(),
  expiresAt: z.date().nullable(),
  saved: z.boolean(),
  savedBy: z.array(clientIdSchema),
  access: accessSchema,
  bans: z.array(clientIdSchema),
  joinCode: joinCodeSchema,
  labId: shareIdSchema.optional(),
  forkOf: shareIdSchema.optional(),
  locked: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  /** First lines of the main file for lists; valid while `updatedAt` is not after `previewAt`. */
  preview: z.string().optional(),
  previewAt: z.date().optional(),
});
export type ShareRecord = z.infer<typeof shareRecordSchema>;

/** One person's folder and tags for a share (§5 `share_labels`, `_id` = `<clientId>:<shareId>`). */
export const shareLabelRecordSchema = z.object({
  clientId: clientIdSchema,
  shareId: shareIdSchema,
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.date(),
});
export type ShareLabelRecord = z.infer<typeof shareLabelRecordSchema>;

export const updateRecordSchema = z.object({
  shareId: shareIdSchema,
  seq: z.number().int().positive(),
  data: binarySchema,
  at: z.date(),
});
export type UpdateRecord = z.infer<typeof updateRecordSchema>;

export const SNAPSHOT_KINDS = ["compact", "history"] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export const snapshotRecordSchema = z.object({
  shareId: shareIdSchema,
  seq: z.number().int().nonnegative(),
  state: binarySchema,
  at: z.date(),
  kind: z.enum(SNAPSHOT_KINDS),
});
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;

export const labStudentSchema = z.object({
  clientId: clientIdSchema,
  name: z.string(),
  shareId: shareIdSchema,
  joinedAt: z.date(),
});
export type LabStudent = z.infer<typeof labStudentSchema>;

export const labRecordSchema = z.object({
  id: shareIdSchema,
  title: z.string(),
  ownerId: clientIdSchema,
  joinCode: joinCodeSchema,
  templateShareId: shareIdSchema.nullable(),
  locked: z.boolean(),
  students: z.array(labStudentSchema),
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type LabRecord = z.infer<typeof labRecordSchema>;

/** GridFS bucket `uploads` file metadata plus identity. */
export const uploadRecordSchema = z.object({
  id: uploadIdSchema,
  name: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
  ownerId: clientIdSchema,
  shareId: shareIdSchema.optional(),
  expiresAt: z.date(),
});
export type UploadRecord = z.infer<typeof uploadRecordSchema>;

export const auditRecordSchema = z.object({
  at: z.date(),
  actor: clientIdSchema,
  ip: z.string(),
  action: z.string(),
  shareId: shareIdSchema.optional(),
  detail: z.unknown().optional(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;
