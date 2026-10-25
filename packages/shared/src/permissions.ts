import type { Role } from "./constants.js";
import { z } from "./zod.js";

/** Absent fields on older shares mean false; text editing remains available to editors. */
export const participantPermissionFields = {
  allowParticipantRename: z.boolean().optional(),
  allowParticipantFiles: z.boolean().optional(),
  allowParticipantLanguage: z.boolean().optional(),
};

export const participantPermissionsSchema = z.object({
  rename: z.boolean(),
  files: z.boolean(),
  language: z.boolean(),
});
export type ParticipantPermissions = z.infer<typeof participantPermissionsSchema>;

export function participantPermissions(
  access: {
    allowParticipantRename?: boolean;
    allowParticipantFiles?: boolean;
    allowParticipantLanguage?: boolean;
  } = {},
): ParticipantPermissions {
  return {
    rename: access.allowParticipantRename === true,
    files: access.allowParticipantFiles === true,
    language: access.allowParticipantLanguage === true,
  };
}

export function canChangeDocument(
  role: Role,
  readOnly: boolean,
  permissions: ParticipantPermissions,
  action: keyof ParticipantPermissions,
): boolean {
  return !readOnly && (role === "owner" || (role === "edit" && permissions[action]));
}

/**
 * Action                              owner   editor       viewer
 * Read/copy/download/fork/save/invite  yes     yes          yes (after admission)
 * Text/format/comments                yes     yes          no (comment deletion: author/owner)
 * Title/files+folders+import/language  yes     owner toggle no
 * Access/lock/kick/approve/end/delete  yes     no           no
 * History read/replay/restore          yes     no           no
 * Broadcast/present                   yes     no           no
 * Private labels/device preferences   own     own          own
 * Templates: anyone can read/create a new share; changing an open share follows files/text.
 * Lab: instructor controls template/distribution/lock and edits students' copies; students own
 * their copy, but a lab lock blocks all their document edits (including owner-only metadata).
 * Instructor edit access does not grant share ownership, history or moderation rights.
 */
