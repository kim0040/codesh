import { z } from "./zod.js";

/** Version and update check (docs/OPERATIONS.md "업데이트", docs/ARCHITECTURE.md §14). */

/** `GET /api/version`: public, so open tabs notice that the server was updated. */
export const versionResponseSchema = z.object({ version: z.string().min(1).max(64) });
export type VersionResponse = z.infer<typeof versionResponseSchema>;

export const UPDATE_CHANNELS = ["stable", "prerelease"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** `pending`: never checked yet. `unreachable`: the last attempt failed (offline, rate limit). */
export const UPDATE_STATUSES = ["ok", "unreachable", "disabled", "pending"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** Release notes are plain text capped at this many characters; clients never render them as HTML. */
export const MAX_RELEASE_NOTES = 4000;

const isoDate = z.iso.datetime();

/** What the update check last learned; the latest-release fields survive a failed attempt. */
export const updateStateSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  /** The release page, `https://github.com/<repo>/releases/tag/<tag>`. */
  url: z.string().nullable(),
  publishedAt: isoDate.nullable(),
  notes: z.string().max(MAX_RELEASE_NOTES).nullable(),
  /** Last attempt, successful or not. */
  checkedAt: isoDate.nullable(),
  status: z.enum(UPDATE_STATUSES),
  updateAvailable: z.boolean(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const UPDATE_POLICIES = ["patch", "minor"] as const;
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number];

export const UPDATE_RUN_RESULTS = [
  "updated",
  "up-to-date",
  "checked",
  "refused",
  "failed",
  "rolled-back",
] as const;

/** `deploy/state/update.json`, written by `deploy/update.sh` and mounted read-only into api. */
export const updaterStatusSchema = z.object({
  auto: z
    .object({
      enabled: z.boolean(),
      at: z.string().max(5).nullable(),
      policy: z.enum(UPDATE_POLICIES).nullable(),
    })
    .nullable(),
  lastRun: z
    .object({
      at: isoDate,
      result: z.enum(UPDATE_RUN_RESULTS),
      from: z.string().max(64).nullable(),
      to: z.string().max(64).nullable(),
      message: z.string().max(500).nullable(),
    })
    .nullable(),
});
export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;

/** `GET /api/admin/update` and `POST /api/admin/update/check`. */
export const adminUpdateResponseSchema = updateStateSchema.extend({
  repo: z.string(),
  channel: z.enum(UPDATE_CHANNELS),
  /** `https://github.com/<repo>/releases`, where the offline bundles are. */
  releasesUrl: z.string(),
  /** `null` when deploy/state/update.json is not mounted (source installs, development). */
  updater: updaterStatusSchema.nullable(),
});
export type AdminUpdateResponse = z.infer<typeof adminUpdateResponseSchema>;
