import { detectLanguage, getLanguage, PLAIN_TEXT_ID } from "@codesh/highlight";
import { Button, EmptyState, Sheet, SheetContent, toast } from "@codesh/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Bookmark,
  Copy,
  Download,
  FileArchive,
  GitFork,
  History,
  Keyboard,
  MessageSquare,
  Presentation,
  Settings,
  Share2,
  Upload,
  UserRound,
  Wand2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useIsNarrow } from "../../lib/appearance";
import { setFileLanguage } from "../../lib/collab/model";
import { type Command, registerCommands } from "../../lib/commands";
import { useT } from "../../lib/i18n";
import { openShortcuts } from "../../lib/overlays";
import { isAltGraph, KEYS } from "../../lib/platform";
import { getPrefs } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { copyAll, downloadFile, downloadZip, looksLikeSecret } from "./actions";
import { EditorBanners } from "./banners";
import { CommentsPanel } from "./CommentsPanel";
import { useEditor } from "./context";
import { showAloneHint } from "./doc-info";
import { collectDroppedFiles } from "./dropped-files";
import { EditorPane } from "./EditorPane";
import { FileTabs, FileTree, useFileOps } from "./Files";
import { canFormat, formatCode, minimalChange } from "./format-code";
import { HistoryView } from "./HistoryView";
import { IdentityDialog } from "./IdentityDialog";
import { SettingsSheet } from "./SettingsSheet";
import { ShareDialog } from "./ShareDialog";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { UploadDialog, useImport } from "./UploadDialog";
import type { FollowResult } from "./use-follow";

/** Shown over an empty share nobody else has joined yet. */
function AloneHint() {
  const t = useT();
  const ctx = useEditor();
  const length = useStore(ctx.info).length;
  if (!showAloneHint({ participants: ctx.participants.length, length, readOnly: ctx.readOnly }))
    return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <div className="pointer-events-auto max-w-sm rounded-xl border border-line bg-panel p-3 shadow-2">
        <EmptyState
          size="sm"
          title={t("empty.alone.title")}
          description={t("empty.alone.body")}
          action={
            <Button
              size="sm"
              variant="primary"
              leading={<Share2 />}
              onClick={() => ctx.openPanel("share")}
            >
              {t("editor.top.shareAction")}
            </Button>
          }
        />
      </div>
    </div>
  );
}

export function EditorShell({ follow }: { follow: FollowResult }) {
  const t = useT();
  const ctx = useEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const narrow = useIsNarrow();
  const ops = useFileOps();
  const importDropped = useImport();
  const [treeOpen, setTreeOpen] = useState(ctx.files.length > 1);
  const [secretWarning, setSecretWarning] = useState(false);
  const language = ctx.activeFile.language;

  // ── actions ──────────────────────────────────────────────────────
  const actions = useRef({
    copyAll: async () => {},
    downloadFile: () => {},
    downloadZip: () => {},
    format: async () => {},
    toggleSaved: async () => {},
    fork: async () => {},
  });

  actions.current = {
    copyAll: async () => {
      const ok = await copyAll(ctx.doc, ctx.activeFile);
      toast({
        title: ok ? t("toast.allCopied") : t("toast.copyFailed"),
        tone: ok ? "success" : "danger",
        duration: 2500,
      });
    },
    downloadFile: () => {
      downloadFile(ctx.doc, ctx.activeFile);
      toast({ title: t("toast.downloadStarted"), tone: "neutral", duration: 2000 });
    },
    downloadZip: () => {
      downloadZip(ctx.doc, ctx.files, ctx.meta.title);
      toast({ title: t("toast.downloadStarted"), tone: "neutral", duration: 2000 });
    },
    format: async () => {
      const view = ctx.viewRef.current;
      if (!view || ctx.readOnly || !canFormat(language)) return;
      const before = view.state.doc.toString();
      const prefs = getPrefs();
      try {
        const after = await formatCode(before, language, {
          tabWidth: prefs.tabSize,
          useTabs: prefs.indentWithTabs,
        });
        if (view.state.doc.toString() !== before) return;
        const change = minimalChange(before, after);
        if (change) view.dispatch({ changes: change });
        toast({ title: t("toast.formatted"), tone: "success", duration: 2000 });
      } catch {
        toast({ title: t("toast.formatFailed"), tone: "danger" });
      }
    },
    toggleSaved: async () => {
      const next = !ctx.share.saved;
      try {
        const share = await api.patchShare(ctx.share.id, { saved: next });
        queryClient.setQueryData(["share", ctx.share.id], share);
        void queryClient.invalidateQueries({ queryKey: ["shares"] });
        toast({
          title: next ? t("toast.saved") : t("toast.unsaved"),
          tone: "success",
          duration: 2500,
        });
      } catch {
        toast({ title: t("error.generic"), tone: "danger" });
      }
    },
    fork: async () => {
      try {
        const copy = await api.forkShare(ctx.share.id);
        toast({ title: t("toast.forked"), tone: "success", duration: 2500 });
        void queryClient.invalidateQueries({ queryKey: ["shares"] });
        void navigate({ to: "/$id", params: { id: copy.id } });
      } catch {
        toast({ title: t("error.generic"), tone: "danger" });
      }
    },
  };

  const topActions = {
    copyAll: () => void actions.current.copyAll(),
    downloadFile: () => actions.current.downloadFile(),
    downloadZip: () => actions.current.downloadZip(),
    format: () => void actions.current.format(),
    toggleSaved: () => void actions.current.toggleSaved(),
    fork: () => void actions.current.fork(),
  };

  const topActionsRef = useRef(topActions);
  topActionsRef.current = topActions;

  // ── keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // AltGr (Ctrl+Alt on Windows) types characters; it is never one of these shortcuts.
      if (isAltGraph(event)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.altKey && event.code === "KeyS") {
        event.preventDefault();
        ctx.openPanel("share");
      } else if (mod && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        ctx.openPanel("settings");
      } else if (mod && event.altKey && event.code === "KeyH" && ctx.isOwner) {
        event.preventDefault();
        ctx.openPanel("history");
      } else if (mod && event.altKey && event.code === "KeyM") {
        event.preventDefault();
        ctx.openPanel("comments");
      } else if (mod && event.altKey && event.code === "KeyC") {
        event.preventDefault();
        topActionsRef.current.copyAll();
      } else if (event.shiftKey && event.altKey && !mod && event.code === "KeyF") {
        event.preventDefault();
        topActionsRef.current.format();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ctx.isOwner, ctx.openPanel]);

  // ── command palette entries ──────────────────────────────────────
  useEffect(() => {
    const group = t("editor.top.menu");
    const commands: Command[] = [
      {
        id: "share",
        label: t("editor.top.shareAction"),
        group,
        icon: <Share2 />,
        shortcut: [KEYS.mod, KEYS.alt, "S"],
        run: () => ctx.openPanel("share"),
      },
      {
        id: "settings",
        label: t("editor.top.settingsAction"),
        group,
        icon: <Settings />,
        shortcut: [KEYS.mod, ","],
        run: () => ctx.openPanel("settings"),
      },
      {
        id: "comments",
        label: t("editor.top.commentsAction"),
        group,
        icon: <MessageSquare />,
        shortcut: [KEYS.mod, KEYS.alt, "M"],
        run: () => ctx.openPanel("comments"),
      },
      {
        id: "history",
        label: t("editor.top.historyAction"),
        group,
        icon: <History />,
        disabled: !ctx.isOwner,
        shortcut: [KEYS.mod, KEYS.alt, "H"],
        run: () => ctx.openPanel("history"),
      },
      {
        id: "copy-all",
        label: t("editor.top.copyAllAction"),
        group,
        icon: <Copy />,
        shortcut: [KEYS.mod, KEYS.alt, "C"],
        run: () => topActionsRef.current.copyAll(),
      },
      {
        id: "download",
        label: t("editor.download.fileAction"),
        group,
        icon: <Download />,
        run: () => topActionsRef.current.downloadFile(),
      },
      {
        id: "zip",
        label: t("editor.download.zipAction"),
        group,
        icon: <FileArchive />,
        disabled: ctx.files.length < 2,
        run: () => topActionsRef.current.downloadZip(),
      },
      {
        id: "format",
        label: t("editor.top.formatAction"),
        group,
        icon: <Wand2 />,
        disabled: ctx.readOnly || !canFormat(language),
        shortcut: [KEYS.shift, KEYS.alt, "F"],
        run: () => topActionsRef.current.format(),
      },
      {
        id: "save",
        label: ctx.share.saved ? t("editor.top.unsaveAction") : t("editor.top.saveAction"),
        group,
        icon: <Bookmark />,
        run: () => topActionsRef.current.toggleSaved(),
      },
      {
        id: "fork",
        label: t("editor.top.forkAction"),
        group,
        icon: <GitFork />,
        run: () => topActionsRef.current.fork(),
      },
      {
        id: "upload",
        label: t("upload.title"),
        group,
        icon: <Upload />,
        disabled: ctx.readOnly,
        run: () => ctx.openPanel("upload"),
      },
      {
        id: "identity",
        label: t("identity.editAction"),
        group,
        icon: <UserRound />,
        run: () => ctx.openPanel("identity"),
      },
      {
        id: "present",
        label: ctx.presenting ? t("editor.present.stopAction") : t("editor.present.action"),
        group,
        icon: <Presentation />,
        disabled: !ctx.isOwner,
        run: () => ctx.setPresenting(!ctx.presenting),
      },
      {
        id: "shortcuts",
        label: t("editor.top.shortcutsAction"),
        group,
        icon: <Keyboard />,
        shortcut: ["?"],
        run: openShortcuts,
      },
    ];
    return registerCommands("editor", commands);
  }, [
    t,
    ctx.isOwner,
    ctx.readOnly,
    ctx.presenting,
    ctx.share.saved,
    ctx.files.length,
    language,
    ctx.openPanel,
    ctx.setPresenting,
  ]);

  // ── paste: detect the language of an empty file, warn about secrets ─
  const onPaste = useCallback(
    (text: string, wasEmpty: boolean) => {
      if (looksLikeSecret(text)) setSecretWarning(true);
      if (!wasEmpty || (language && language !== PLAIN_TEXT_ID)) return;
      const result = detectLanguage({ filename: ctx.activeFile.path, content: text });
      if (result.language && result.confidence >= 0.5) {
        setFileLanguage(ctx.doc, ctx.activeFile.id, result.language.id);
        toast({
          title: t("status.language.changed", {
            language: getLanguage(result.language.id)?.name ?? "",
          }),
          tone: "neutral",
          duration: 2500,
        });
      }
    },
    [ctx.activeFile.id, ctx.activeFile.path, ctx.doc, language, t],
  );

  const onDropFiles = useCallback(
    (transfer: DataTransfer) => {
      if (ctx.readOnly) return;
      void collectDroppedFiles(transfer).then(importDropped);
    },
    [ctx.readOnly, importDropped],
  );

  const tree = <FileTree ops={ops} />;
  const showSidebar = treeOpen && !narrow;

  return (
    <div className="screen-fill flex flex-col bg-bg text-fg">
      <TopBar actions={topActions} />
      <EditorBanners
        secretWarning={secretWarning}
        onKeepSecret={() => setSecretWarning(false)}
        onStopFollow={follow.stop}
      />

      <main id="main" className="flex min-h-0 flex-1">
        {showSidebar ? (
          <aside className="hidden w-56 shrink-0 border-e border-line bg-panel md:block">
            {tree}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {ctx.panel.name === "history" && ctx.isOwner ? (
            <HistoryView />
          ) : (
            <>
              <FileTabs
                ops={ops}
                treeOpen={treeOpen || (narrow && ctx.panel.name === "files")}
                onToggleTree={() =>
                  narrow ? ctx.openPanel("files") : setTreeOpen((open) => !open)
                }
              />
              <div className="relative min-h-0 flex-1">
                <EditorPane
                  key={`${ctx.activeFile.id}`}
                  session={ctx.session}
                  fileId={ctx.activeFile.id}
                  languageId={language}
                  readOnly={ctx.readOnly}
                  viewRef={ctx.viewRef}
                  info={ctx.info}
                  onPaste={onPaste}
                  onOpenComments={(ids) => ctx.openPanel("comments", ids[0])}
                  onDropFiles={onDropFiles}
                />
                <AloneHint />
              </div>
            </>
          )}
        </div>
      </main>

      <StatusBar />

      {ops.dialogs}
      <ShareDialog />
      <SettingsSheet />
      <CommentsPanel />
      <UploadDialog />
      <IdentityDialog />
      <Sheet
        open={narrow && ctx.panel.name === "files"}
        onOpenChange={(open) => !open && ctx.closePanel()}
      >
        <SheetContent
          side="left"
          title={t("editor.files.title")}
          hideTitle
          closeLabel={t("common.close")}
        >
          {tree}
        </SheetContent>
      </Sheet>
    </div>
  );
}
