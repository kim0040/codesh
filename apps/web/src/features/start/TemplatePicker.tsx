import { getLanguage } from "@codesh/highlight";
import type { MessageKey, TFunction } from "@codesh/i18n";
import type { Template } from "@codesh/shared";
import {
  Button,
  cx,
  Dialog,
  DialogContent,
  EmptyState,
  isImeKey,
  LanguageBadge,
  Skeleton,
} from "@codesh/ui";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search, SearchX, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { firstLines } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { setTemplatesOpen, useOverlays } from "../../lib/overlays";
import { useCreateShare } from "./use-create-share";

const PREVIEW_LINES = 14;

/** A template with its texts resolved: built-in ones store i18n keys, organization ones text. */
interface Item {
  template: Template;
  name: string;
  description: string;
  languageName: string;
  color: string;
}

function toItem(template: Template, t: TFunction): Item {
  const language = getLanguage(template.language);
  return {
    template,
    name: template.builtin ? t(template.name as MessageKey) : template.name,
    description: template.builtin ? t(template.description as MessageKey) : template.description,
    languageName: language?.name ?? template.language,
    color: language?.color ?? "#8b949e",
  };
}

function matches(item: Item, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    item.name,
    item.description,
    item.languageName,
    ...item.template.files.map((file) => file.path),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * "Start from a template": a searchable list of starting points with a preview of the files. Opened
 * from the start panel and the command palette; choosing one creates the share and opens it.
 */
export function TemplatePicker() {
  const { templates: open } = useOverlays();
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={setTemplatesOpen}>
      <DialogContent
        title={t("template.title")}
        description={t("template.description")}
        closeLabel={t("common.close")}
        size="xl"
      >
        {open ? <PickerBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody() {
  const t = useT();
  const create = useCreateShare();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: ({ signal }) => api.listTemplates(signal),
    staleTime: 60_000,
    retry: false,
  });

  const items = useMemo(
    () => (templates.data ?? []).map((template) => toItem(template, t)),
    [templates.data, t],
  );
  const shown = useMemo(() => items.filter((item) => matches(item, query)), [items, query]);
  const builtin = shown.filter((item) => item.template.builtin);
  const organization = shown.filter((item) => !item.template.builtin);
  // Keyboard order is the order on screen: built-in ones first, then the organization's.
  const ordered = [...builtin, ...organization];
  const active = ordered.find((item) => item.template.id === activeId) ?? ordered[0];

  useEffect(() => {
    if (!active) return;
    document
      .getElementById(`${listId}-${active.template.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    const index = active ? ordered.indexOf(active) : 0;
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))];
    if (next) setActiveId(next.template.id);
  };

  const start = async (item: Item | undefined) => {
    if (!item || create.pending) return;
    if (await create.createFromTemplate(item.template)) setTemplatesOpen(false);
  };

  if (templates.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("template.loading")}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-9" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (templates.isError) {
    return (
      <EmptyState
        tone="danger"
        icon={<TriangleAlert />}
        title={t("template.error.title")}
        description={t("template.error.body")}
        action={<Button onClick={() => void templates.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const renderOption = (item: Item) => {
    const selected = item.template.id === active?.template.id;
    return (
      <div
        key={item.template.id}
        id={`${listId}-${item.template.id}`}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        onClick={() => setActiveId(item.template.id)}
        onDoubleClick={() => void start(item)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void start(item);
        }}
        data-testid={`template-${item.template.id}`}
        className={cx(
          "flex cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 coarse:min-h-11",
          selected ? "bg-fill-selected" : "hover:bg-fill-hover",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body-sm font-medium">{item.name}</span>
        </span>
        {/* fg-3 on the selected fill is below 4.5:1 in the dark theme. */}
        <span
          className={cx(
            "flex min-w-0 items-center gap-2 text-caption",
            selected ? "text-fg-2" : "text-fg-3",
          )}
        >
          <LanguageBadge name={item.languageName} color={item.color} />
          <span className="shrink-0">
            {t("template.files", { count: item.template.files.length })}
          </span>
        </span>
        {item.description ? (
          <span className="line-clamp-2 text-caption text-fg-2">{item.description}</span>
        ) : null}
      </div>
    );
  };
  const renderGroup = (key: string, label: string, group: readonly Item[]) =>
    group.length === 0 ? null : (
      // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is not allowed inside a listbox
      <div key={key} role="group" aria-labelledby={`${listId}-group-${key}`}>
        <div id={`${listId}-group-${key}`} className="px-2 pt-2 pb-1 text-caption text-fg-3">
          {label}
        </div>
        {group.map(renderOption)}
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-md border border-line-control bg-panel px-3 focus-within:border-accent-text">
        <Search aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker exists to be typed into
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active.template.id}` : undefined}
          aria-label={t("template.searchLabel")}
          placeholder={t("template.searchPlaceholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={(event) => {
            // Enter that finishes a Korean syllable is not a choice yet.
            if (isImeKey(event.nativeEvent)) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              void start(active);
            }
          }}
          className="h-10 min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-fg-3 coarse:text-base"
          data-testid="template-search"
        />
      </div>

      {ordered.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<SearchX />}
          title={t("template.empty.title", { query: query.trim() })}
          description={t("template.empty.body")}
          action={<Button onClick={() => setQuery("")}>{t("template.empty.action")}</Button>}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div
            id={listId}
            role="listbox"
            aria-label={t("template.listLabel")}
            className="max-h-64 overflow-y-auto md:max-h-[50dvh]"
            data-testid="template-list"
          >
            {renderGroup("builtin", t("template.group.builtin"), builtin)}
            {renderGroup("org", t("template.group.org"), organization)}
          </div>
          {active ? <Preview item={active} /> : null}
        </div>
      )}

      <div className="sticky bottom-0 -mx-1 flex justify-end gap-2 bg-overlay px-1 py-2">
        <Button
          variant="primary"
          disabled={!active}
          loading={create.pending}
          loadingLabel={t("common.loading")}
          onClick={() => void start(active)}
          data-testid="template-create"
        >
          {t("template.createAction")}
        </Button>
      </div>
    </div>
  );
}

function Preview({ item }: { item: Item }) {
  const t = useT();
  const first = item.template.files[0];
  return (
    <section
      aria-label={t("template.previewLabel", { name: item.name })}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3"
      data-testid="template-preview"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-body font-semibold">{item.name}</h3>
        <LanguageBadge name={item.languageName} color={item.color} />
        {item.description ? <p className="text-body-sm text-fg-2">{item.description}</p> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <h4 className="text-label font-medium text-fg-2">{t("template.filesLabel")}</h4>
        <ul className="flex flex-col gap-0.5" data-testid="template-files">
          {item.template.files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-center gap-2 text-caption">
              <FileText aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 truncate font-mono">{file.path}</span>
            </li>
          ))}
        </ul>
      </div>
      {first ? (
        // biome-ignore lint/a11y/useSemanticElements: a <section> can not wrap the text of a <pre>
        <pre
          // Focusable so the keyboard can scroll long lines and many lines.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus
          tabIndex={0}
          role="region"
          aria-label={t("template.previewCode", { path: first.path })}
          className="max-h-40 overflow-auto rounded-md bg-bg p-2 font-mono text-[0.6875rem] leading-snug text-fg-2"
        >
          {firstLines(first.content, PREVIEW_LINES)}
        </pre>
      ) : null}
    </section>
  );
}
