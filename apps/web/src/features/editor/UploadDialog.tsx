import { Button, Dialog, DialogContent, Spinner, toast } from "@codesh/ui";
import { FolderUp, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useEditor } from "./context";
import { collectDroppedFiles } from "./dropped-files";
import { importFiles } from "./import-files";

/** Adds dropped or picked files (and folders, and .zip archives) to the open share. */
export function useImport() {
  const t = useT();
  const ctx = useEditor();
  return async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const result = await importFiles(ctx.doc, ctx.files, files);
      if (result.firstId) ctx.setActiveFileId(result.firstId);
      if (result.added > 0)
        toast({ title: t("toast.uploaded", { count: result.added }), tone: "success" });
      if (result.skipped > 0 || result.tooMany || result.added === 0) {
        toast({
          title: result.tooMany ? t("editor.files.limit", { max: 100 }) : t("toast.uploadFailed"),
          tone: "warning",
        });
      }
    } catch {
      toast({ title: t("toast.uploadFailed"), tone: "danger" });
    }
  };
}

export function UploadDialog() {
  const t = useT();
  const ctx = useEditor();
  const run = useImport();
  const open = ctx.panel.name === "upload";
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const handle = async (files: File[]) => {
    setBusy(true);
    await run(files);
    setBusy(false);
    ctx.closePanel();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && ctx.closePanel()}>
      <DialogContent size="md" title={t("upload.title")} closeLabel={t("common.close")}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the buttons inside do the same job from the keyboard */}
        <div
          role="presentation"
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void collectDroppedFiles(event.dataTransfer).then(handle);
          }}
          data-drop-over={over || undefined}
          className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line-strong p-8 text-center"
          data-testid="upload-zone"
        >
          {busy ? (
            <Spinner label={t("upload.progress", { count: 1 })} />
          ) : (
            <>
              <Upload aria-hidden="true" className="size-6 text-fg-3" />
              <p className="text-body-sm">{t("upload.dropHint")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => filesInput.current?.click()} leading={<Upload />}>
                  {t("upload.browseAction")}
                </Button>
                <Button onClick={() => folderInput.current?.click()} leading={<FolderUp />}>
                  {t("upload.title")}
                </Button>
              </div>
            </>
          )}
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            data-testid="upload-input"
            onChange={(event) => void handle(Array.from(event.target.files ?? []))}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            // @ts-expect-error non-standard attribute for picking a folder
            webkitdirectory=""
            onChange={(event) => void handle(Array.from(event.target.files ?? []))}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
