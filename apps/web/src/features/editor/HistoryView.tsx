import {
  diff,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  unifiedMergeView,
} from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, History, Pause, Play, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { api } from "../../lib/api";
import { useAppearance, useIsNarrow, usePrefersReducedMotion } from "../../lib/appearance";
import { fileText, readFiles } from "../../lib/collab/model";
import { errorText } from "../../lib/errors";
import { useLocale, useT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { fontExtension } from "./cm/extensions";
import { useEditor } from "./context";

const SPEEDS = [1, 2, 4] as const;
const BASE_STEP_MS = 900;

interface Snapshot {
  files: { id: string; path: string }[];
  texts: Record<string, string>;
}

function snapshotOf(bytes: Uint8Array): Snapshot {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, bytes);
    const files = readFiles(doc);
    const texts: Record<string, string> = {};
    for (const file of files) texts[file.id] = fileText(doc, file.id).toString();
    return { files: files.map(({ id, path }) => ({ id, path })), texts };
  } finally {
    doc.destroy();
  }
}

function useSnapshot(shareId: string, seq: number | undefined) {
  return useQuery({
    queryKey: ["history-state", shareId, seq],
    enabled: seq !== undefined,
    queryFn: async () => snapshotOf(await api.historyState(shareId, seq as number)),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

/** Added and removed line counts between two texts. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diff(before, after)) {
    removed += lineCount(before.slice(change.fromA, change.toA));
    added += lineCount(after.slice(change.fromB, change.toB));
  }
  return { added, removed };
}

/** Owner-only: scrub, play back and compare earlier versions, then restore one. */
export function HistoryView() {
  const t = useT();
  const [locale] = useLocale();
  const ctx = useEditor();
  const queryClient = useQueryClient();
  const reduced = usePrefersReducedMotion();
  const shareId = ctx.share.id;

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

  const selected = index ?? entries.length - 1;
  const entry = entries[selected];
  const previous = entries[selected - 1];

  const selectedState = useSnapshot(shareId, entry?.seq);
  const previousState = useSnapshot(shareId, previous?.seq);

  // Playback advances one version per tick and stops on the last one.
  useEffect(() => {
    if (!playing) return;
    if (selected >= entries.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex(selected + 1), BASE_STEP_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, selected, entries.length, speed]);

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

  const currentText = fileText(ctx.doc, fileId).toString();
  const snapshotFiles = selectedState.data?.files ?? [];
  const fileOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const file of ctx.files) seen.set(file.id, file.path);
    for (const file of snapshotFiles) if (!seen.has(file.id)) seen.set(file.id, file.path);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [ctx.files, snapshotFiles]);

  const selectedText = selectedState.data?.texts[fileId] ?? "";
  const baseText =
    against === "current"
      ? currentText
      : (previousState.data?.texts[fileId] ?? (previous ? "" : selectedText));
  const stats = diffStats(baseText, selectedText);
  const loadingState = entry !== undefined && selectedState.isPending;

  return (
    <section
      aria-label={t("history.title")}
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="history-view"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex items-center gap-2 text-body-sm font-semibold">
          <History aria-hidden="true" className="size-4" />
          {t("history.title")}
        </h2>
        <span className="text-caption text-fg-3">{t("history.privacy")}</span>
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
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
            <IconButton
              aria-label={playing ? t("history.pauseAction") : t("history.playAction")}
              variant="secondary"
              onClick={() => {
                if (!playing && selected >= entries.length - 1) setIndex(0);
                setPlaying(!playing);
              }}
              data-testid="history-play"
            >
              {playing ? <Pause /> : <Play />}
            </IconButton>
            <input
              type="range"
              min={0}
              max={entries.length - 1}
              step={1}
              value={selected}
              aria-label={t("history.timelineLabel")}
              aria-valuetext={
                entry
                  ? `${t("history.version", { n: selected + 1 })}, ${new Date(entry.at).toLocaleString(locale)}`
                  : undefined
              }
              onChange={(event) => {
                setPlaying(false);
                setIndex(Number(event.target.value));
              }}
              data-testid="history-slider"
              className="min-w-40 flex-1 accent-(--accent) coarse:h-10"
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
              <span className="text-caption text-fg-2 tabular" data-testid="history-label">
                {selected === entries.length - 1
                  ? t("history.current")
                  : t("history.version", { n: selected + 1 })}
                {" · "}
                {formatRelativeTime(locale, new Date(entry.at).getTime() - Date.now())}
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <fieldset className="flex gap-1">
              <legend className="sr-only">{t("history.compareAction")}</legend>
              <Button
                size="sm"
                variant={against === "previous" ? "soft" : "ghost"}
                onClick={() => setAgainst("previous")}
              >
                {t("history.version", { n: Math.max(1, selected) })}
              </Button>
              <Button
                size="sm"
                variant={against === "current" ? "soft" : "ghost"}
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
              />
            ) : null}
            <span className="text-caption text-fg-3" data-testid="history-stats">
              {stats.added > 0 || stats.removed > 0
                ? `${t("diff.added", { count: stats.added })} · ${t("diff.removed", { count: stats.removed })}`
                : t("diff.noChanges")}
            </span>
            <Button
              variant="primary"
              size="sm"
              leading={<RotateCcw />}
              className="ms-auto"
              disabled={!entry || selected === entries.length - 1}
              onClick={() => setConfirming(true)}
              data-testid="history-restore"
            >
              {t("history.restoreAction")}
            </Button>
          </div>

          <div className="min-h-0 flex-1" aria-live="off">
            {loadingState ? (
              <div className="p-4" aria-busy="true">
                <Skeleton className="h-64 w-full" />
              </div>
            ) : selectedState.isError ? (
              <EmptyState
                tone="danger"
                title={t("history.error.title")}
                description={t("history.error.body")}
                action={
                  <Button onClick={() => void selectedState.refetch()}>{t("common.retry")}</Button>
                }
              />
            ) : (
              <DiffPane
                before={baseText}
                after={selectedText}
                languageId={ctx.files.find((file) => file.id === fileId)?.language ?? ""}
                animate={!reduced}
              />
            )}
          </div>
        </>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          size="sm"
          title={t("history.restoreTitle")}
          description={t("history.restoreBody")}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                loading={restore.isPending}
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

function DiffPane({
  before,
  after,
  languageId,
  animate,
}: {
  before: string;
  after: string;
  languageId: string;
  animate: boolean;
}) {
  const t = useT();
  const prefs = usePrefs();
  const appearance = useAppearance();
  const narrow = useIsNarrow();
  const hostRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<EditorView | null>(null);
  const [language, setLanguage] = useState<Extension>([]);
  const themeId = prefs.editorTheme === "auto" ? DEFAULT_THEME_ID[appearance] : prefs.editorTheme;
  void animate;

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
    if (narrow) {
      const view = new EditorView({
        parent,
        doc: after,
        extensions: [
          ...shared,
          unifiedMergeView({ original: before, mergeControls: false, gutter: true }),
        ],
      });
      targetRef.current = view;
      return () => {
        targetRef.current = null;
        view.destroy();
      };
    }
    const merge = new MergeView({
      parent,
      a: { doc: before, extensions: shared },
      b: { doc: after, extensions: shared },
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    targetRef.current = merge.b;
    return () => {
      targetRef.current = null;
      merge.destroy();
    };
  }, [before, after, themeId, prefs.fontSize, language, narrow]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-line text-caption text-fg-3">
        {!narrow ? (
          <div className="grid flex-1 grid-cols-2">
            <span className="px-3 py-1">{t("diff.before")}</span>
            <span className="border-s border-line px-3 py-1">{t("diff.after")}</span>
          </div>
        ) : (
          <span className="flex-1 px-3 py-1">{t("diff.inline")}</span>
        )}
        <IconButton
          aria-label={t("diff.previousChange")}
          size="sm"
          onClick={() => targetRef.current && goToPreviousChunk(targetRef.current)}
        >
          <ArrowUp />
        </IconButton>
        <IconButton
          aria-label={t("diff.nextChange")}
          size="sm"
          onClick={() => targetRef.current && goToNextChunk(targetRef.current)}
        >
          <ArrowDown />
        </IconButton>
      </div>
      <div ref={hostRef} className="cm-merge-host min-h-0 flex-1" data-testid="diff" />
    </div>
  );
}
