import { MAX_DOC_BYTES_LIMIT, MAX_TEMPLATES, MAX_TEMPLATES_TOTAL_BYTES } from "./constants.js";
import { settingsTemplateSchema, templateBytes } from "./templates.js";
import { z } from "./zod.js";

/** Admin-editable settings (§10). Object fields use `prefault` so nested defaults apply. */

export const roomSchema = z.object({
  name: z.string().min(1),
  cidrs: z.array(z.string().min(1)),
});
export type Room = z.infer<typeof roomSchema>;

// Provider shapes are defined with the optional login work (M5).
const authProviderSchema = z.record(z.string(), z.unknown());

export const settingsSchema = z
  .object({
    anonymousTtlHours: z.number().positive().default(24),
    historyRetentionDays: z.number().int().nonnegative().default(7),
    maxDocBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_DOC_BYTES_LIMIT)
      .default(5 * 1024 * 1024),
    maxUploadMB: z.number().positive().default(200),
    guestAllowed: z.boolean().default(true),
    rooms: z.array(roomSchema).default([]),
    subnetPrefixV4: z.number().int().min(8).max(32).default(24),
    nearbyDefault: z.boolean().default(true),
    audit: z
      .object({
        enabled: z.boolean().default(false),
        retentionDays: z.number().int().positive().default(90),
      })
      .prefault({}),
    secretWarning: z.boolean().default(true),
    auth: z
      .object({
        oidc: authProviderSchema.nullable().default(null),
        ldap: authProviderSchema.nullable().default(null),
      })
      .prefault({}),
    contact: z.string().default(""),
    templates: z.array(settingsTemplateSchema).max(MAX_TEMPLATES).default([]),
  })
  .superRefine((settings, ctx) => {
    const ids = new Set<string>();
    let total = 0;
    for (const [index, template] of settings.templates.entries()) {
      if (ids.has(template.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "id"],
          message: "duplicate template id",
        });
      }
      ids.add(template.id);
      const bytes = templateBytes(template.files);
      total += bytes;
      if (bytes > settings.maxDocBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["templates", index, "files"],
          message: "template is larger than maxDocBytes",
        });
      }
    }
    if (total > MAX_TEMPLATES_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["templates"],
        message: `templates are larger than ${MAX_TEMPLATES_TOTAL_BYTES} bytes together`,
      });
    }
  });
export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS_DOC_ID = "global";

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}
