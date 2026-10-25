import {
  detectLanguage,
  getLanguage,
  LANGUAGES,
  type LanguageEntry,
  PLAIN_TEXT_ID,
} from "@codesh/highlight";
import { LanguageBadge, Popover, PopoverContent, PopoverTrigger, toast } from "@codesh/ui";
import { Check, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { fileText, setFileLanguage } from "../../lib/collab/model";
import { useT } from "../../lib/i18n";
import { useStore } from "../../lib/store";
import { useDocumentPermissions, useEditor } from "./context";

const STATUS_TEXT = {
  connected: "status.connected",
  connecting: "status.reconnecting",
  reconnecting: "status.reconnecting",
  offline: "status.offline",
  disconnected: "status.disconnected",
} as const;

const STATUS_DOT = {
  connected: "bg-success",
  connecting: "bg-warning",
  reconnecting: "bg-warning",
  offline: "bg-warning",
  disconnected: "bg-danger",
} as const;

export function StatusBar({
  suggestedLanguage,
  onUseSuggestion,
  onDismissSuggestion,
}: {
  suggestedLanguage: LanguageEntry | null;
  onUseSuggestion: () => void;
  onDismissSuggestion: () => void;
}) {
  const t = useT();
  const ctx = useEditor();
  const info = useStore(ctx.info);
  const status = ctx.state.status;
  const language = getLanguage(ctx.activeFile.language);
  const online = ctx.participants.length;

  return (
    <section
      aria-label={t("a11y.statusBar")}
      className="flex min-h-8 shrink-0 items-center gap-x-3 gap-y-1 overflow-x-auto border-t border-line bg-panel px-3 py-1 text-caption text-fg-2 whitespace-nowrap coarse:min-h-10"
    >
      <span
        role="status"
        className="flex items-center gap-1.5"
        data-testid="connection-status"
        data-status={status}
      >
        <span aria-hidden="true" className={`size-2 rounded-full ${STATUS_DOT[status]}`} />
        {t(STATUS_TEXT[status])}
      </span>

      {ctx.rtt !== null ? (
        <span title={t("status.latencyLabel")} className="tabular" data-testid="rtt">
          {t("status.latency", { ms: ctx.rtt })}
        </span>
      ) : null}

      <span className="tabular" data-testid="cursor-position">
        {t("status.cursor", { line: info.line, col: info.col })}
      </span>
      {info.selected > 0 ? (
        <span className="tabular">{t("status.selection", { count: info.selected })}</span>
      ) : null}

      <span className="ms-auto flex items-center gap-3">
        <span className="hidden items-center gap-1 sm:flex">
          <Users aria-hidden="true" className="size-3.5" />
          {t("status.participants", { count: online })}
        </span>
        {suggestedLanguage && !ctx.readOnly ? (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex min-h-7 items-center gap-1 rounded-md border border-line px-1.5 text-caption text-fg coarse:min-h-9"
            data-testid="language-suggestion"
          >
            <span>{t("status.language.suggestion", { language: suggestedLanguage.name })}</span>
            <button
              type="button"
              onClick={onUseSuggestion}
              className="rounded px-1 font-medium text-accent-text hover:bg-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-text"
            >
              {t("status.language.suggestionUse")}
            </button>
            <button
              type="button"
              aria-label={t("status.language.suggestionDismiss")}
              onClick={onDismissSuggestion}
              className="rounded px-1 text-fg-2 hover:bg-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-text"
            >
              ×
            </button>
          </span>
        ) : null}
        <LanguagePicker
          label={language?.name ?? t("status.language.auto")}
          color={language?.color ?? "#8b949e"}
        />
      </span>
    </section>
  );
}

function LanguagePicker({ label, color }: { label: string; color: string }) {
  const t = useT();
  const ctx = useEditor();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const canChange = useDocumentPermissions().language;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (entry) =>
        entry.aliases.some((alias) => alias.includes(q)) || entry.name.toLowerCase().includes(q),
    );
  }, [query]);

  const choose = (id: string) => {
    if (!canChange) return;
    setFileLanguage(ctx.doc, ctx.activeFile.id, id);
    const entry = getLanguage(id);
    toast({
      title: t("status.language.changed", { language: entry?.name ?? t("status.language.auto") }),
      tone: "neutral",
      duration: 2500,
    });
    setOpen(false);
  };

  const detectNow = () => {
    const text = fileText(ctx.doc, ctx.activeFile.id).toString();
    const result = detectLanguage({ filename: ctx.activeFile.path, content: text });
    choose(result.language?.id ?? PLAIN_TEXT_ID);
  };

  const trigger = (
    <button
      type="button"
      disabled={!canChange}
      title={!canChange ? t("perm.ownerOnly") : undefined}
      aria-label={`${t("status.language.label")}: ${label}. ${t("status.language.changeAction")}`}
      data-testid="language-button"
      data-tour="language"
      className="inline-flex h-6 items-center rounded-md px-1.5 hover:bg-fill-hover disabled:hover:bg-transparent coarse:h-9"
    >
      <LanguageBadge name={label} color={color} />
    </button>
  );
  if (!canChange) return trigger;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        aria-label={t("status.language.label")}
        className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 p-2"
      >
        <input
          // biome-ignore lint/a11y/noAutofocus: opening the picker is a request to search
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("status.language.searchLabel")}
          placeholder={t("status.language.searchPlaceholder")}
          className="h-8 rounded-md border border-line-control bg-panel px-2 text-body-sm focus:border-accent-text coarse:h-11 coarse:text-base"
        />
        <ul className="max-h-64 overflow-y-auto" aria-label={t("status.language.label")}>
          {!query ? (
            <li>
              <button type="button" onClick={detectNow} className={ITEM}>
                <span className="flex-1">{t("status.language.auto")}</span>
              </button>
            </li>
          ) : null}
          {matches.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => choose(entry.id)}
                aria-current={entry.id === ctx.activeFile.language || undefined}
                className={ITEM}
              >
                <LanguageBadge name={entry.name} color={entry.color} className="flex-1" />
                {entry.id === ctx.activeFile.language ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {matches.length === 0 ? (
          <p role="status" className="px-2 py-3 text-center text-body-sm text-fg-3">
            {t("status.language.noResults", { query })}
          </p>
        ) : null}
        <p className="px-1 text-caption text-fg-3">{t("status.language.syncNote")}</p>
      </PopoverContent>
    </Popover>
  );
}

const ITEM =
  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-start text-body-sm hover:bg-fill-hover coarse:min-h-11";
