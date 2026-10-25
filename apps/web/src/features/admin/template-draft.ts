import type { TFunction } from "@gachipad/i18n";
import {
  MAX_TEMPLATE_DESCRIPTION_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATES_TOTAL_BYTES,
  type SettingsTemplate,
  settingsTemplateSchema,
  templateBytes,
} from "@gachipad/shared";
import { formatBytes } from "../../lib/format";

export interface DraftFile {
  /** Stable key while the files are edited; the path itself changes. */
  key: number;
  path: string;
  /** Kept as stored: templates created through the API may set one, the editor has no field for it. */
  language?: string;
  content: string;
}

export interface Draft {
  id: string;
  name: string;
  language: string;
  description: string;
  files: DraftFile[];
}

export interface Errors {
  name?: string;
  language?: string;
  description?: string;
  files?: string;
  /** Problems the form has no field for, such as an id that is not valid. */
  form?: string;
  paths: Record<number, string>;
}

let fileKey = 0;
export const newFile = (path = "", content = "", language?: string): DraftFile => ({
  key: fileKey++,
  path,
  content,
  ...(language === undefined ? {} : { language }),
});

export function toDraft(template: SettingsTemplate): Draft {
  return {
    id: template.id,
    name: template.name,
    language: template.language,
    description: template.description,
    files: template.files.map((file) => newFile(file.path, file.content, file.language)),
  };
}

/**
 * Checks the draft with the schema the server uses, so a refusal there can not surprise.
 * `otherBytes` is the size of the organization's other templates, which share one total limit.
 */
export function validate(
  draft: Draft,
  maxDocBytes: number,
  otherBytes: number,
  t: TFunction,
): { template: SettingsTemplate } | { errors: Errors } {
  const candidate = {
    id: draft.id,
    name: draft.name,
    language: draft.language,
    description: draft.description,
    files: draft.files.map(({ path, content, language }) => ({
      path: path.trim(),
      content,
      ...(language === undefined ? {} : { language }),
    })),
  };
  const parsed = settingsTemplateSchema.safeParse(candidate);
  const errors: Errors = { paths: {} };
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [field, index, sub] = issue.path;
      if (field === "id") errors.form = t("admin.template.error.id");
      else if (field === "name")
        errors.name = t("admin.template.error.name", { max: MAX_TEMPLATE_NAME_LENGTH });
      else if (field === "description") {
        errors.description = t("admin.template.error.description", {
          max: MAX_TEMPLATE_DESCRIPTION_LENGTH,
        });
      } else if (field === "language") errors.language = t("admin.template.error.language");
      else if (field === "files" && typeof index === "number" && sub === "path") {
        errors.paths[index] = t("admin.template.error.path");
      } else if (field === "files") {
        errors.files =
          draft.files.length === 0
            ? t("admin.template.error.files")
            : t("admin.template.error.duplicatePath");
      }
    }
  } else if (templateBytes(parsed.data.files) > maxDocBytes) {
    errors.files = t("admin.template.error.size", { size: formatBytes(maxDocBytes) });
  } else if (otherBytes + templateBytes(parsed.data.files) > MAX_TEMPLATES_TOTAL_BYTES) {
    errors.files = t("admin.template.error.total", {
      size: formatBytes(MAX_TEMPLATES_TOTAL_BYTES),
    });
  } else {
    return { template: parsed.data };
  }
  return { errors };
}
