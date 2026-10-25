import { getLanguage, LANGUAGES } from "@gachipad/highlight";
import {
  generateShareId,
  MAX_FILES_PER_SHARE,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_TEMPLATES,
  MAX_TEMPLATES_TOTAL_BYTES,
  type SettingsTemplate,
  templateBytes,
} from "@gachipad/shared";
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Input,
  LanguageBadge,
  Select,
  useFieldProps,
} from "@gachipad/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
  type Draft,
  type DraftFile,
  type Errors,
  newFile,
  toDraft,
  validate,
} from "./template-draft";

const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.id,
  label: language.name,
}));

export interface TemplatesEditorProps {
  templates: readonly SettingsTemplate[];
  maxDocBytes: number;
  onChange: (templates: SettingsTemplate[]) => void;
}

/** Admin list of the organization's code templates: add, edit and delete (after confirming). */
export function TemplatesEditor({ templates, maxDocBytes, onChange }: TemplatesEditorProps) {
  const t = useT();
  const [editing, setEditing] = useState<{ index: number | null; draft: Draft } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const full = templates.length >= MAX_TEMPLATES;
  const target = deleting === null ? undefined : templates[deleting];
  const totalBytes = templates.reduce((sum, template) => sum + templateBytes(template.files), 0);

  const add = () => {
    const taken = new Set(templates.map((template) => template.id));
    let id = `org-${generateShareId().toLowerCase()}`;
    while (taken.has(id)) id = `org-${generateShareId().toLowerCase()}`;
    setEditing({
      index: null,
      draft: { id, name: "", language: "plaintext", description: "", files: [newFile("main.txt")] },
    });
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4"
      data-testid="templates-editor"
    >
      <div>
        <h2 className="text-body-sm font-semibold">{t("admin.setting.group.templates")}</h2>
        <p className="text-caption text-fg-3">{t("admin.setting.templates.hint")}</p>
      </div>

      {templates.length === 0 ? (
        <p className="text-body-sm text-fg-3">{t("admin.setting.templates.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="template-rows">
          {templates.map((template, index) => {
            const language = getLanguage(template.language);
            const tooLarge = templateBytes(template.files) > maxDocBytes;
            return (
              <li
                key={template.id}
                data-testid={`template-row-${template.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                  <span className="truncate text-body-sm font-medium">{template.name}</span>
                  <span className="flex flex-wrap items-center gap-x-3 text-caption text-fg-3">
                    <LanguageBadge
                      name={language?.name ?? template.language}
                      color={language?.color ?? "#8b949e"}
                    />
                    <span>{t("template.files", { count: template.files.length })}</span>
                  </span>
                  {tooLarge ? (
                    <span className="text-caption text-danger-text">
                      {t("admin.template.error.size", { size: formatBytes(maxDocBytes) })}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    aria-label={`${t("admin.setting.templates.editAction")}: ${template.name}`}
                    size="sm"
                    onClick={() => setEditing({ index, draft: toDraft(template) })}
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    aria-label={`${t("admin.setting.templates.deleteAction")}: ${template.name}`}
                    size="sm"
                    onClick={() => setDeleting(index)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          leading={<Plus />}
          disabled={full}
          onClick={add}
          data-testid="template-add"
        >
          {t("admin.setting.templates.addAction")}
        </Button>
        {full ? (
          <span className="text-caption text-fg-3">
            {t("admin.setting.templates.limit", { max: MAX_TEMPLATES })}
          </span>
        ) : null}
      </div>
      {templates.length > 0 ? (
        <p
          className={
            totalBytes > MAX_TEMPLATES_TOTAL_BYTES
              ? "text-caption text-danger-text"
              : "text-caption text-fg-3"
          }
          data-testid="templates-total"
        >
          {totalBytes > MAX_TEMPLATES_TOTAL_BYTES
            ? t("admin.setting.templates.totalTooLarge", {
                max: formatBytes(MAX_TEMPLATES_TOTAL_BYTES),
              })
            : t("admin.setting.templates.total", {
                used: formatBytes(totalBytes),
                max: formatBytes(MAX_TEMPLATES_TOTAL_BYTES),
              })}
        </p>
      ) : null}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          size="xl"
          title={t(
            editing?.index === null ? "admin.template.addTitle" : "admin.template.editTitle",
          )}
          closeLabel={t("common.close")}
        >
          {editing ? (
            <TemplateForm
              key={editing.draft.id}
              initial={editing.draft}
              maxDocBytes={maxDocBytes}
              otherBytes={templates.reduce(
                (sum, template, i) =>
                  i === editing.index ? sum : sum + templateBytes(template.files),
                0,
              )}
              onCancel={() => setEditing(null)}
              onSave={(template) => {
                onChange(
                  editing.index === null
                    ? [...templates, template]
                    : templates.map((item, i) => (i === editing.index ? template : item)),
                );
                setEditing(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={target !== undefined} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent
          size="sm"
          title={t("admin.setting.templates.deleteTitle", { name: target?.name ?? "" })}
          description={t("admin.setting.templates.deleteBody")}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
              <Button
                variant="danger"
                data-testid="template-delete-confirm"
                onClick={() => {
                  if (deleting !== null) onChange(templates.filter((_, i) => i !== deleting));
                  setDeleting(null);
                }}
              >
                {t("admin.setting.templates.deleteAction")}
              </Button>
            </>
          }
        >
          <span className="sr-only">{target?.name}</span>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TemplateForm({
  initial,
  maxDocBytes,
  otherBytes,
  onCancel,
  onSave,
}: {
  initial: Draft;
  maxDocBytes: number;
  otherBytes: number;
  onCancel: () => void;
  onSave: (template: SettingsTemplate) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Errors | null>(null);
  const patch = (next: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...next }));
  const patchFile = (key: number, next: Partial<DraftFile>) =>
    patch({ files: draft.files.map((file) => (file.key === key ? { ...file, ...next } : file)) });

  const submit = () => {
    const result = validate(draft, maxDocBytes, otherBytes, t);
    if ("template" in result) onSave(result.template);
    else setErrors(result.errors);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        // The dialog is portalled, but React still bubbles its submit to the settings form, which
        // would save every setting each time a template is confirmed.
        event.stopPropagation();
        submit();
      }}
    >
      {errors?.form ? (
        <p role="alert" className="text-caption text-danger-text">
          {errors.form}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("admin.template.nameLabel")} error={errors?.name}>
          <Input
            value={draft.name}
            maxLength={MAX_TEMPLATE_NAME_LENGTH * 2}
            onChange={(event) => patch({ name: event.target.value })}
            data-testid="template-name"
          />
        </Field>
        <Field label={t("admin.template.languageLabel")} error={errors?.language}>
          <Select
            value={draft.language}
            options={LANGUAGE_OPTIONS}
            onValueChange={(language) => patch({ language })}
          />
        </Field>
      </div>
      <Field label={t("admin.template.descriptionLabel")} error={errors?.description}>
        <Input
          value={draft.description}
          onChange={(event) => patch({ description: event.target.value })}
          data-testid="template-description"
        />
      </Field>

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 p-0">
        <legend className="mb-2 text-label font-medium">{t("admin.template.filesLabel")}</legend>
        {errors?.files ? (
          <p role="alert" className="text-caption text-danger-text">
            {errors.files}
          </p>
        ) : null}
        {draft.files.map((file, index) => (
          <div
            key={file.key}
            className="flex flex-col gap-2 rounded-lg border border-line p-3"
            data-testid="template-file"
          >
            <div className="flex items-start gap-2">
              <Field
                label={t("admin.template.pathLabel")}
                hint={t("admin.template.pathHint")}
                error={errors?.paths[index]}
                className="min-w-0 flex-1"
              >
                <Input
                  value={file.path}
                  spellCheck={false}
                  onChange={(event) => patchFile(file.key, { path: event.target.value })}
                  data-testid="template-file-path"
                />
              </Field>
              <IconButton
                aria-label={`${t("admin.template.removeFileAction")}: ${file.path || index + 1}`}
                size="sm"
                className="mt-6"
                disabled={draft.files.length === 1}
                onClick={() =>
                  patch({ files: draft.files.filter((item) => item.key !== file.key) })
                }
              >
                <Trash2 />
              </IconButton>
            </div>
            <Field
              label={t("admin.template.contentLabel", { path: file.path || String(index + 1) })}
            >
              <CodeArea
                value={file.content}
                onChange={(content) => patchFile(file.key, { content })}
                testId="template-file-content"
              />
            </Field>
          </div>
        ))}
        <Button
          size="sm"
          leading={<Plus />}
          className="self-start"
          disabled={draft.files.length >= MAX_FILES_PER_SHARE}
          onClick={() => patch({ files: [...draft.files, newFile()] })}
          data-testid="template-add-file"
        >
          {t("admin.template.addFileAction")}
        </Button>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" data-testid="template-done">
          {t("admin.template.doneAction")}
        </Button>
      </div>
    </form>
  );
}

/** A monospaced textarea that takes its id and ARIA wiring from the surrounding `Field`. */
function CodeArea({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  const field = useFieldProps();
  return (
    <textarea
      {...field}
      rows={8}
      spellCheck={false}
      wrap="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      data-testid={testId}
      className="w-full overflow-x-auto rounded-md border border-line-control bg-panel p-2 font-mono text-caption focus:border-accent-text"
    />
  );
}
