import {
  MAX_FOLDER_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_SHARE,
  type PutLabelsBody,
  putLabelsBodySchema,
  type ShareListItem,
} from "@codesh/shared";
import { Button, cx, Dialog, DialogContent, Field, Input, isImeKey, toast } from "@codesh/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FolderPlus, Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, isApiError } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import {
  type FolderEntry,
  labelKey,
  listFolders,
  listTags,
  resolveFolderName,
  suggestFolders,
  suggestTags,
} from "../../lib/labels";

const MAX_SUGGESTIONS = 8;

interface OrganizeDialogProps {
  /** The share to organize; null keeps the dialog closed. */
  share: ShareListItem | null;
  /** Every share in the list: the source of the existing folders and tags. */
  shares: readonly ShareListItem[];
  onClose: () => void;
}

/** Sets the folder and tags of one share (`PUT /api/shares/:id/labels`). Only the person sees them. */
export function OrganizeDialog({ share, shares, onClose }: OrganizeDialogProps) {
  const t = useT();
  const formId = useId();
  // Lives here because Radix closes the dialog on Escape before the combobox sees the key.
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (share === null) setListOpen(false);
  }, [share]);
  return (
    <Dialog open={share !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        // With the folder list open, the first Escape closes the list and keeps the dialog.
        onEscapeKeyDown={(event) => {
          if (!listOpen) return;
          event.preventDefault();
          setListOpen(false);
        }}
        title={t("myshares.organize.title", { title: share?.title || t("common.untitled") })}
        description={t("myshares.organize.body")}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" form={formId} variant="primary" data-testid="organize-save">
              {t("common.save")}
            </Button>
          </>
        }
      >
        {share ? (
          <OrganizeForm
            key={share.id}
            formId={formId}
            share={share}
            shares={shares}
            listOpen={listOpen}
            onListOpen={setListOpen}
            onDone={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OrganizeForm({
  formId,
  share,
  shares,
  listOpen,
  onListOpen,
  onDone,
}: {
  formId: string;
  share: ShareListItem;
  shares: readonly ShareListItem[];
  listOpen: boolean;
  onListOpen: (open: boolean) => void;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [folderText, setFolderText] = useState(share.folder ?? "");
  const [tags, setTags] = useState<string[]>(share.tags);
  const [tagText, setTagText] = useState("");
  const [errors, setErrors] = useState<{ folder?: string; tags?: string }>({});

  const others = useMemo(() => shares.filter((item) => item.id !== share.id), [shares, share.id]);
  const existingFolders = useMemo(() => listFolders(shares).folders, [shares]);
  const existingTags = useMemo(() => listTags(others), [others]);

  const save = useMutation({
    mutationFn: (body: PutLabelsBody) => api.putLabels(share.id, body),
    onSuccess: (labels) => {
      queryClient.setQueryData<ShareListItem[]>(["shares"], (old) =>
        old?.map((item) =>
          item.id === share.id ? { ...item, folder: labels.folder, tags: labels.tags } : item,
        ),
      );
      toast({ title: t("myshares.organize.saved"), tone: "success", duration: 2500 });
      onDone();
    },
    onError: (failure) => {
      if (isApiError(failure, "not_found")) {
        // The share left the list in the meantime (unsaved elsewhere, expired).
        void queryClient.invalidateQueries({ queryKey: ["shares"] });
      }
      const text = errorText(failure);
      toast({
        title: t(text.title),
        description: text.hint ? t(text.hint) : undefined,
        tone: "danger",
      });
    },
  });

  const addTags = (names: readonly string[]) => {
    setTags((current) => {
      const next = [...current];
      for (const raw of names) {
        const name = raw.trim().slice(0, MAX_TAG_LENGTH);
        if (!name || next.length >= MAX_TAGS_PER_SHARE) continue;
        if (!next.some((tag) => labelKey(tag) === labelKey(name))) next.push(name);
      }
      return next;
    });
  };

  const submit = () => {
    // A tag that was typed but not confirmed still counts.
    const pending = tagText.trim();
    const finalTags = [...tags];
    if (
      pending &&
      finalTags.length < MAX_TAGS_PER_SHARE &&
      !finalTags.some((tag) => labelKey(tag) === labelKey(pending))
    ) {
      finalTags.push(pending);
    }
    const parsed = putLabelsBodySchema.safeParse({
      folder: resolveFolderName(folderText, existingFolders),
      tags: finalTags,
    });
    if (!parsed.success) {
      const next: { folder?: string; tags?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "folder") {
          next.folder =
            issue.code === "too_big"
              ? t("myshares.organize.folderTooLong", { max: MAX_FOLDER_LENGTH })
              : t("myshares.organize.folderInvalid");
        } else {
          next.tags =
            issue.code === "too_big"
              ? t("myshares.organize.tagTooLong", { max: MAX_TAG_LENGTH })
              : t("myshares.organize.tagInvalid");
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  return (
    <form
      id={formId}
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FolderField
        value={folderText}
        onChange={(value) => {
          setFolderText(value);
          setErrors((current) => ({ ...current, folder: undefined }));
        }}
        open={listOpen}
        onOpen={onListOpen}
        folders={existingFolders}
        error={errors.folder ?? null}
      />
      <TagsField
        tags={tags}
        text={tagText}
        error={errors.tags}
        onText={(value) => {
          setTagText(value);
          setErrors((current) => ({ ...current, tags: undefined }));
        }}
        onAdd={addTags}
        onRemove={(index) => setTags((current) => current.filter((_, i) => i !== index))}
        suggestions={suggestTags(existingTags, tags, tagText).slice(0, MAX_SUGGESTIONS)}
      />
    </form>
  );
}

type FolderOption =
  | { kind: "none" }
  | { kind: "folder"; name: string; count: number }
  | { kind: "create"; name: string };

/** Combobox (ARIA 1.2 list autocomplete): type to filter or create, arrows and Enter to pick. */
function FolderField({
  value,
  onChange,
  open,
  onOpen: setOpen,
  folders,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  folders: readonly FolderEntry[];
  error: string | null;
}) {
  const t = useT();
  const listId = useId();
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const typed = value.trim();
  const options = useMemo<FolderOption[]>(() => {
    const list: FolderOption[] = [];
    if (typed === "" || folders.length > 0) list.push({ kind: "none" });
    for (const folder of suggestFolders(folders, typed)) {
      list.push({ kind: "folder", name: folder.name, count: folder.count });
    }
    if (typed && !folders.some((folder) => folder.key === labelKey(typed))) {
      list.push({ kind: "create", name: typed });
    }
    return list;
  }, [folders, typed]);

  const choose = (option: FolderOption | undefined) => {
    if (!option) return;
    onChange(option.kind === "none" ? "" : option.name);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that finishes a Korean syllable is not a choice yet.
    if (isImeKey(event.nativeEvent)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(options[active]);
    }
    // Escape is handled by the dialog (`onEscapeKeyDown`): the first one closes the list.
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the list when focus leaves the combobox; the input and options carry the roles
    <div
      ref={root}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      className="relative flex flex-col gap-1.5"
    >
      <Field
        label={t("myshares.folder.nameLabel")}
        hint={t("myshares.organize.folderHint")}
        error={error ?? undefined}
      >
        <Input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          maxLength={MAX_FOLDER_LENGTH}
          placeholder={t("myshares.organize.folderPlaceholder")}
          leading={<FolderPlus />}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          data-testid="organize-folder"
        />
      </Field>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("myshares.folder.title")}
          // Floats over the fields below, so closing it never moves the buttons under the pointer.
          className="absolute inset-x-0 top-full z-10 max-h-44 overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-3"
        >
          {folders.length === 0 && typed === "" ? (
            <p className="px-2 py-1.5 text-caption text-fg-3">
              {t("myshares.organize.folderEmpty")}
            </p>
          ) : null}
          {options.map((option, index) => (
            <div
              key={option.kind === "none" ? "none" : `${option.kind}:${option.name}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                if (event.key === "Enter") choose(option);
              }}
              data-testid={`folder-option-${option.kind}`}
              className={cx(
                "flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-body-sm coarse:min-h-11",
                index === active && "bg-fill-hover",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {option.kind === "none"
                  ? t("myshares.organize.folderNone")
                  : option.kind === "create"
                    ? t("myshares.organize.folderCreate", { name: option.name })
                    : option.name}
              </span>
              {option.kind === "folder" ? (
                <span className="shrink-0 text-caption text-fg-3 tabular-nums">{option.count}</span>
              ) : null}
              {(option.kind === "none" && typed === "") ||
              (option.kind === "folder" && labelKey(option.name) === labelKey(typed)) ? (
                <Check aria-hidden="true" className="size-4 shrink-0 text-accent-text" />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TagsField({
  tags,
  text,
  error,
  onText,
  onAdd,
  onRemove,
  suggestions,
}: {
  tags: readonly string[];
  text: string;
  error?: string;
  onText: (value: string) => void;
  onAdd: (names: readonly string[]) => void;
  onRemove: (index: number) => void;
  suggestions: readonly { key: string; name: string }[];
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusNext, setFocusNext] = useState<number | "input" | null>(null);
  const full = tags.length >= MAX_TAGS_PER_SHARE;

  // After a chip is removed, focus moves to its neighbour so keyboard users keep their place.
  useEffect(() => {
    if (focusNext === null) return;
    if (focusNext === "input") input.current?.focus();
    else chips.current[focusNext]?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const remove = (index: number) => {
    onRemove(index);
    setFocusNext(tags.length <= 1 ? "input" : Math.min(index, tags.length - 2));
  };

  const commit = () => {
    if (!text.trim()) return;
    onAdd([text]);
    onText("");
  };

  return (
    <div className="flex flex-col gap-2">
      <Field
        label={t("myshares.organize.tagsLabel")}
        hint={
          full
            ? t("myshares.organize.tagLimit", { max: MAX_TAGS_PER_SHARE })
            : text.length >= MAX_TAG_LENGTH
              ? t("myshares.organize.tagTooLong", { max: MAX_TAG_LENGTH })
              : t("myshares.organize.tagHint", { max: MAX_TAGS_PER_SHARE })
        }
        error={error}
      >
        <Input
          ref={input}
          autoComplete="off"
          maxLength={MAX_TAG_LENGTH}
          // Not `disabled`: the input has focus when the last tag is added, and a disabled element loses it.
          readOnly={full}
          placeholder={t("myshares.organize.tagPlaceholder")}
          value={text}
          onChange={(event) => {
            const parts = event.target.value.split(/[,，]/);
            if (parts.length > 1) {
              onAdd(parts.slice(0, -1));
              onText(parts[parts.length - 1] ?? "");
            } else {
              onText(event.target.value);
            }
          }}
          onKeyDown={(event) => {
            if (isImeKey(event.nativeEvent)) return;
            if (event.key === "Enter") {
              // Enter confirms the tag; the form is saved with the button or by Enter on an empty field.
              if (text.trim()) {
                event.preventDefault();
                commit();
              }
            } else if (event.key === "Backspace" && text === "" && tags.length > 0) {
              remove(tags.length - 1);
            }
          }}
          trailing={
            <Button
              size="sm"
              variant="ghost"
              leading={<Plus />}
              disabled={full || !text.trim()}
              onClick={() => {
                commit();
                input.current?.focus();
              }}
              className="-me-2"
            >
              {t("myshares.organize.tagAddAction")}
            </Button>
          }
          data-testid="organize-tag-input"
        />
      </Field>
      {tags.length > 0 ? (
        <ul
          aria-label={t("myshares.organize.tagsLabel")}
          className="flex flex-wrap gap-1.5"
          data-testid="organize-tags"
        >
          {tags.map((tag, index) => (
            <li key={labelKey(tag)} className="max-w-full">
              <button
                type="button"
                ref={(element) => {
                  chips.current[index] = element;
                }}
                aria-label={t("myshares.organize.tagRemove", { tag })}
                onClick={() => remove(index)}
                onKeyDown={(event) => {
                  if (event.key === "Backspace" || event.key === "Delete") {
                    event.preventDefault();
                    remove(index);
                  }
                }}
                className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-full bg-fill-active py-0.5 ps-2.5 pe-1.5 text-label text-fg-2 hover:text-fg coarse:min-h-10"
              >
                <span className="min-w-0 truncate">{tag}</span>
                <X aria-hidden="true" className="size-3.5 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-caption text-fg-3">
        {t("myshares.organize.tagCount", { count: tags.length, max: MAX_TAGS_PER_SHARE })}
      </p>
      {suggestions.length > 0 && !full ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-caption text-fg-3">{t("myshares.organize.tagSuggestions")}</p>
          <ul className="flex flex-wrap gap-1.5" data-testid="organize-suggestions">
            {suggestions.map((tag) => (
              <li key={tag.key} className="max-w-full">
                <button
                  type="button"
                  onClick={() => {
                    onAdd([tag.name]);
                    input.current?.focus();
                  }}
                  className="inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-label text-fg-2 hover:bg-fill-hover hover:text-fg coarse:min-h-10"
                >
                  <Plus aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{tag.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
