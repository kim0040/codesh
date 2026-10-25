import {
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  originalDocChangeEffect,
  unifiedMergeView,
} from "@codemirror/merge";
import { ChangeSet, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DEFAULT_THEME_ID, getEditorTheme, getLanguage } from "@codesh/highlight";
import { formatRelativeTime } from "@codesh/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  IconButton,
  Select,
  Skeleton,
  toast,
} from "@codesh/ui";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, History, Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { api } from "../../lib/api";
import { useAppearance, useIsNarrow } from "../../lib/appearance";
import { fileText, readFiles } from "../../lib/collab/model";
import { errorText } from "../../lib/errors";
import { useLocale, useT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { usePublicSettings } from "../../lib/public-settings";
import { fontExtension } from "./cm/extensions";
import { useEditor } from "./context";
import { minimalChange } from "./format-code";
import { chunkStats, nextStepDelay, prefetchRange } from "./history-playback";

const SPEEDS = [1, 2, 4] as const;
const BASE_STEP_MS = 900;
/** Dragging the timeline fetches the version under the thumb once it rests this long. */
const SCRUB_DEBOUNCE_MS = 90;
/** The previous version dims only when the next one takes longer than this, so fast loads never flicker. */
const STALE_DIM_MS = 160;
const COLLAPSE = { margin: 3, minSize: 6 };
const DIFF_CONFIG = { scanLimit: 2_000, timeout: 40 };

interface Snapshot {
  files: { id: string; path: string; language: string }[];
  texts: Record<string, string>;
}

function snapshotOf(bytes: Uint8Array): Snapshot {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    const files = readFiles(doc);
    const texts: Record<string, string> = {};
    for (const file of files) texts[file.id] = fileText(doc, file.id).toString();
    return { files: files.map(({ id, path, language }) => ({ id, path, language })), texts };
  } finally {
    doc.destroy();
  }
}

/** Decoded versions stay cached for the session; leaving the window cancels a fetch still running. */
function snapshotQuery(shareId: string, seq: number) {
  return {
    queryKey: ["history-state", shareId, seq] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      snapshotOf(await api.historyState(shareId, seq, signal)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  };
}

interface Shown {
  index: number;
  after: Snapshot;
  /** The version before `index`, or null for the first one. */
  before: Snapshot | null;
}

/** Owner-only: scrub, play back and compare earlier versions, then restore one. */
export function HistoryView() {
  const t = useT();
  const [locale] = useLocale();
  const ctx = useEditor();
  const queryClient = useQueryClient();
  const shareId = ctx.share.id;
  const retentionDays = usePublicSettings()?.historyRetentionDays;

  const list = useQuery({
    queryKey: ["history", shareId],
    queryFn: () => api.listHistory(shareId),
    staleTime: 0,
    retry: false,
  });
  const entries = useMemo(() => [...(list.data ?? [])].sort((a, b) => a.seq - b.seq), [list.data]);
  const [index, setIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [against, setAgainst] = useState<"previous" | "current">("previous");
  const [fileId, setFileId] = useState(ctx.activeFile.id);
  const [confirming, setConfirming] = useState(false);
  const [stats, setStats] = useState({ added: 0, removed: 0 });

  const last = entries.length - 1;
  const target = Math.min(index ?? last, last);
  const entry = entries[target];

  // While the thumb moves, only the version it rests on is fetched.
  const [settled, setSettled] = useState(target);
  useEffect(() => {
    if (playing) {
      setSettled(target);
      return;
    }
    const timer = window.setTimeout(() => setSettled(target), SCRUB_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [target, playing]);

  const focus = index === null ? target : Math.min(settled, last);
  const nearby = prefetchRange(focus, entries.length, playing);
  const states = useQueries({
    queries: nearby.map((at) => snapshotQuery(shareId, entries[at]?.seq ?? -1)),
  });
  // Reading `data` from the results is what makes a finished fetch re-render this view (React Query
  // only notifies about the fields a component reads); versions outside the window come from the cache.
  const cached = (at: number): Snapshot | undefined => {
    const slot = nearby.indexOf(at);
    if (slot >= 0) return states[slot]?.data;
    const seq = entries[at]?.seq;
    return seq === undefined
      ? undefined
      : queryClient.getQueryData<Snapshot>(snapshotQuery(shareId, seq).queryKey);
  };
  const targetState = states[nearby.indexOf(target)];

  // What is on screen: the target once it (and its diff base) is in memory, until then the last one
  // shown. Playback and scrubbing never fall back to an empty or loading pane.
  const [shown, setShown] = useState<Shown | null>(null);
  const after = cached(target);
  const before = target > 0 ? cached(target - 1) : null;
  const ready = after !== undefined && (against === "current" || before !== undefined);
  if (
    ready &&
    (shown?.index !== target || shown.after !== after || shown.before !== (before ?? null))
  ) {
    setShown({ index: target, after, before: before ?? null });
  }
  const stale = shown !== null && shown.index !== target;

  const [dim, setDim] = useState(false);
  useEffect(() => {
    if (!stale || playing) {
      setDim(false);
      return;
    }
    const timer = window.setTimeout(() => setDim(true), STALE_DIM_MS);
    return () => window.clearTimeout(timer);
  }, [stale, playing]);

  // Playback: the next step starts once the current version is on screen, on a steady beat.
  const stepMs = BASE_STEP_MS / speed;
  const issuedAt = useRef(0);
  const shownIndex = shown?.index;
  useEffect(() => {
    if (!playing || shownIndex !== target) return;
    if (target >= last) {
      setPlaying(false);
      return;
    }
    const now = performance.now();
    const delay = nextStepDelay(issuedAt.current, now, stepMs);
    const timer = window.setTimeout(() => {
      issuedAt.current = now + delay;
      setIndex(target + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [playing, shownIndex, target, last, stepMs]);

  const targetFailed = targetState?.isError === true;
  useEffect(() => {
    if (targetFailed) setPlaying(false);
  }, [targetFailed]);

  const restore = useMutation({
    mutationFn: (seq: number) => api.restore(shareId, seq),
    onSuccess: () => {
      toast({ title: t("toast.restored"), tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["history", shareId] });
      setConfirming(false);
      ctx.closePanel();
    },
    onError: (error) => {
      const text = errorText(error);
      toast({ title: t(text.title), tone: "danger" });
      setConfirming(false);
    },
  });

  const times = useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const dated = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const today = new Date().toDateString();
    return (at: string) => {
      const date = new Date(at);
      return date.toDateString() === today ? time.format(date) : dated.format(date);
    };
  }, [locale]);
  const versionName = (at: number) => {
    const item = entries[at];
    return item ? t("history.version", { time: times(item.at) }) : "";
  };

  const currentText = fileText(ctx.doc, fileId).toString();
  const shownFiles = shown?.after.files;
  const fileOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const file of ctx.files) seen.set(file.id, file.path);
    for (const file of shownFiles ?? []) if (!seen.has(file.id)) seen.set(file.id, file.path);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [ctx.files, shownFiles]);

  const shownText = shown?.after.texts[fileId] ?? "";
  const baseText =
    against === "current"
      ? currentText
      : (shown?.before?.texts[fileId] ?? (shown?.before ? "" : shownText));
  const languageId =
    ctx.files.find((file) => file.id === fileId)?.language ??
    shown?.after.files.find((file) => file.id === fileId)?.language ??
    "";
  const shownAt = shown ? shown.index : target;

  const togglePlay = () => {
    if (!playing && target >= last) setIndex(0);
    issuedAt.current = performance.now();
    setPlaying(!playing);
  };

  return (
    <section
      aria-label={t("history.title")}
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="history-view"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <h2 className="flex items-center gap-2 text-body-sm font-semibold">
          <History aria-hidden="true" className="size-4" />
          {t("history.title")}
        </h2>
        <span className="text-caption text-fg-3">{t("history.privacy")}</span>
        {retentionDays ? (
          <span className="text-caption text-fg-3">
            {t("history.retention", { count: retentionDays })}
          </span>
        ) : null}
        <IconButton
          aria-label={t("common.close")}
          size="sm"
          className="ms-auto"
          onClick={ctx.closePanel}
        >
          <X />
        </IconButton>
      </div>

      {list.isPending ? (
        <div className="flex flex-col gap-2 p-4" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : list.isError ? (
        <EmptyState
          tone="danger"
          title={t("history.error.title")}
          description={t("history.error.body")}
          action={<Button onClick={() => void list.refetch()}>{t("common.retry")}</Button>}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<History />}
          title={t("history.empty.title")}
          description={t("history.empty.body")}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
            <IconButton
              aria-label={playing ? t("history.pauseAction") : t("history.playAction")}
              variant="secondary"
              onClick={togglePlay}
              data-testid="history-play"
            >
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={last}
              step={1}
              value={target}
              aria-label={t("history.timelineLabel")}
              aria-valuetext={
                entry
                  ? `${t("history.position", { n: target + 1, total: entries.length })}, ${versionName(target)}, ${formatRelativeTime(locale, new Date(entry.at).getTime() - Date.now())}`
                  : undefined
              }
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
              onKeyDown={(event) => {
                // Space on the timeline plays and pauses, like a media player.
                if (event.key === " ") {
                  event.preventDefault();
                  togglePlay();
                }
              }}
              data-testid="history-slider"
              className="history-timeline min-w-40 flex-1"
            />
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">{t("history.speedLabel")}</legend>
              {SPEEDS.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={speed === value ? "soft" : "ghost"}
                  aria-pressed={speed === value}
                  onClick={() => setSpeed(value)}
                >
                  {value}×
                </Button>
              ))}
            </fieldset>
            {entry ? (
              <span
                className="flex shrink-0 items-baseline gap-1.5 text-caption text-fg-2 tabular"
                title={formatRelativeTime(locale, new Date(entry.at).getTime() - Date.now())}
                data-testid="history-label"
                data-index={target}
              >
                <span className="font-medium text-fg">
                  {t("history.position", { n: target + 1, total: entries.length })}
                </span>
                <span>{times(entry.at)}</span>
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">{t("history.compareLabel")}</legend>
              <span aria-hidden="true" className="pe-1 text-caption text-fg-3">
                {t("history.compareLabel")}
              </span>
              <Button
                size="sm"
                variant={against === "previous" ? "soft" : "ghost"}
                aria-pressed={against === "previous"}
                onClick={() => setAgainst("previous")}
              >
                {t("history.previous")}
              </Button>
              <Button
                size="sm"
                variant={against === "current" ? "soft" : "ghost"}
                aria-pressed={against === "current"}
                onClick={() => setAgainst("current")}
              >
                {t("history.current")}
              </Button>
            </fieldset>
            {fileOptions.length > 1 ? (
              <Select
                size="sm"
                aria-label={t("editor.files.title")}
                value={fileId}
                onValueChange={setFileId}
                options={fileOptions}
                className="w-auto max-w-64"
              />
            ) : null}
            <span className="text-caption text-fg-3 tabular" data-testid="history-stats">
              {stats.added > 0 || stats.removed > 0
                ? `${t("diff.added", { count: stats.added })} · ${t("diff.removed", { count: stats.removed })}`
                : t("diff.noChanges")}
            </span>
            <Button
              variant="primary"
              size="sm"
              leading={<RotateCcw />}
              className="ms-auto"
              disabled={ctx.readOnly || !entry || target === last || stale}
              onClick={() => setConfirming(true)}
              data-testid="history-restore"
            >
              {t("history.restoreAction")}
            </Button>
          </div>

          {targetFailed && shown ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-soft px-3 py-1.5 text-body-sm text-danger-text"
            >
              {t("history.versionError")}
              <Button size="sm" variant="ghost" onClick={() => void targetState?.refetch()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1" aria-live="off">
            {shown ? (
              <DiffPane
                before={baseText}
                after={shownText}
                beforeLabel={
                  against === "current"
                    ? t("diff.after")
                    : shownAt > 0
                      ? versionName(shownAt - 1)
                      : versionName(shownAt)
                }
                afterLabel={versionName(shownAt)}
                languageId={languageId}
                collapse={!playing}
                follow={playing}
                dim={dim}
                onStats={setStats}
              />
            ) : targetFailed ? (
              <EmptyState
                tone="danger"
                title={t("history.error.title")}
                description={t("history.error.body")}
                action={
                  <Button onClick={() => void targetState?.refetch()}>{t("common.retry")}</Button>
                }
              />
            ) : (
              <div className="p-4" aria-busy="true">
                <Skeleton className="h-64 w-full" />
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          size="sm"
          title={t("history.restoreTitle", { time: entry ? times(entry.at) : "" })}
          description={t("history.restoreBody")}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                loading={restore.isPending}
                disabled={ctx.readOnly}
                loadingLabel={t("common.loading")}
                onClick={() => entry && restore.mutate(entry.seq)}
                data-testid="history-restore-confirm"
              >
                {t("history.restoreAction")}
              </Button>
            </>
          }
        >
          <span className="sr-only">{entry ? new Date(entry.at).toLocaleString(locale) : ""}</span>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * One diff view for the whole session: new versions are applied to it as minimal edits, so the
 * editors, their scroll position and their highlighting survive every step of a playback.
 */
function DiffPane({
  before,
  after,
  beforeLabel,
  afterLabel,
  languageId,
  collapse,
  follow,
  dim,
  onStats,
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  languageId: string;
  /** Fold long unchanged stretches (off while playing, so the code does not jump around). */
  collapse: boolean;
  /** Scroll each new change into view (while playing). */
  follow: boolean;
  /** A newer version is on its way. */
  dim: boolean;
  onStats: (stats: { added: number; removed: number }) => void;
}) {
  const t = useT();
  const prefs = usePrefs();
  const appearance = useAppearance();
  const narrow = useIsNarrow();
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const unifiedRef = useRef<EditorView | null>(null);
  /** The texts the editors hold right now. */
  const held = useRef({ before, after });
  const latest = useRef({ before, after, collapse, onStats });
  latest.current = { before, after, collapse, onStats };
  const [language, setLanguage] = useState<Extension>([]);
  const themeId = prefs.editorTheme === "auto" ? DEFAULT_THEME_ID[appearance] : prefs.editorTheme;

  useEffect(() => {
    let cancelled = false;
    const entry = languageId ? getLanguage(languageId) : undefined;
    if (!entry || entry.engine === "none") {
      setLanguage([]);
      return;
    }
    entry
      .load()
      .then((support) => {
        if (!cancelled) setLanguage(support);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [languageId]);

  const report = () => {
    const merge = mergeRef.current;
    const unified = unifiedRef.current;
    if (merge) {
      latest.current.onStats(chunkStats(merge.chunks, merge.a.state.doc, merge.b.state.doc));
    } else if (unified) {
      const chunks = getChunks(unified.state)?.chunks ?? [];
      latest.current.onStats(chunkStats(chunks, getOriginalDoc(unified.state), unified.state.doc));
    }
  };

  // The editors: built again only when the theme, font, grammar or layout changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: texts are read from refs, so a new version does not rebuild the view
  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const shared: Extension[] = [
      getEditorTheme(themeId).extension,
      fontExtension(prefs.fontSize),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      language,
    ];
    const texts = latest.current;
    held.current = { before: texts.before, after: texts.after };
    if (narrow) {
      const view = new EditorView({
        parent,
        doc: texts.after,
        extensions: [
          ...shared,
          unifiedMergeView({
            original: texts.before,
            mergeControls: false,
            gutter: true,
            diffConfig: DIFF_CONFIG,
          }),
        ],
      });
      unifiedRef.current = view;
      report();
      return () => {
        unifiedRef.current = null;
        view.destroy();
      };
    }
    const merge = new MergeView({
      parent,
      a: { doc: texts.before, extensions: shared },
      b: { doc: texts.after, extensions: shared },
      highlightChanges: true,
      gutter: true,
      diffConfig: DIFF_CONFIG,
      collapseUnchanged: texts.collapse ? COLLAPSE : undefined,
    });
    mergeRef.current = merge;
    report();
    return () => {
      mergeRef.current = null;
      merge.destroy();
    };
  }, [themeId, prefs.fontSize, language, narrow]);

  // A new version: only the part that differs is replaced, in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: report reads the views through refs
  useEffect(() => {
    const changeA = minimalChange(held.current.before, before);
    const changeB = minimalChange(held.current.after, after);
    held.current = { before, after };
    const merge = mergeRef.current;
    const unified = unifiedRef.current;
    const scroll =
      follow && changeB ? EditorView.scrollIntoView(changeB.from, { y: "nearest" }) : null;
    if (merge) {
      if (changeA) merge.a.dispatch({ changes: changeA });
      if (changeB) merge.b.dispatch({ changes: changeB, effects: scroll ?? [] });
      // Folded stretches only shrink as the documents change, so they are worked out afresh.
      if (collapse && (changeA || changeB)) {
        merge.reconfigure({ collapseUnchanged: undefined });
        merge.reconfigure({ collapseUnchanged: COLLAPSE });
      }
    } else if (unified) {
      const original = getOriginalDoc(unified.state);
      unified.dispatch({
        changes: changeB ?? undefined,
        effects: [
          ...(changeA
            ? [originalDocChangeEffect(unified.state, ChangeSet.of(changeA, original.length))]
            : []),
          ...(scroll ? [scroll] : []),
        ],
      });
    }
    if (changeA || changeB) report();
  }, [before, after]);

  useEffect(() => {
    mergeRef.current?.reconfigure({ collapseUnchanged: collapse ? COLLAPSE : undefined });
  }, [collapse]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-line text-caption text-fg-3">
        {!narrow ? (
          <div className="grid min-w-0 flex-1 grid-cols-2">
            <span className="truncate px-3 py-1" title={beforeLabel}>
              {beforeLabel}
            </span>
            <span className="truncate border-s border-line px-3 py-1" title={afterLabel}>
              {afterLabel}
            </span>
          </div>
        ) : (
          <span
            className="min-w-0 flex-1 truncate px-3 py-1"
            title={`${beforeLabel} → ${afterLabel}`}
          >
            {beforeLabel} → {afterLabel}
          </span>
        )}
        <IconButton
          aria-label={t("diff.previousChange")}
          size="sm"
          onClick={() => {
            const view = mergeRef.current?.b ?? unifiedRef.current;
            if (view) goToPreviousChunk(view);
          }}
        >
          <ArrowUp />
        </IconButton>
        <IconButton
          aria-label={t("diff.nextChange")}
          size="sm"
          onClick={() => {
            const view = mergeRef.current?.b ?? unifiedRef.current;
            if (view) goToNextChunk(view);
          }}
        >
          <ArrowDown />
        </IconButton>
      </div>
      <div
        ref={hostRef}
        className="cm-merge-host min-h-0 flex-1"
        data-stale={dim || undefined}
        data-testid="diff"
      />
    </div>
  );
}
