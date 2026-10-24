import { formatRelativeTime } from "@codesh/i18n";
import type { Comment } from "@codesh/shared";
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  Sheet,
  SheetContent,
  Switch,
  toast,
} from "@codesh/ui";
import { Check, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { useIsNarrow } from "../../lib/appearance";
import { useComments } from "../../lib/collab/hooks";
import {
  addComment,
  deleteComment,
  fileText,
  newCommentId,
  updateComment,
} from "../../lib/collab/model";
import { useLocale, useT } from "../../lib/i18n";
import { commentRange } from "./cm/comments-ext";
import { labelColorFor } from "./cm/remote-cursors";
import { useEditor } from "./context";

const MAX_COMMENT_LENGTH = 2000;

interface Draft {
  fileId: string;
  anchor: unknown;
  head: unknown;
  line: number;
  quote: string;
}

export function CommentsPanel() {
  const t = useT();
  const ctx = useEditor();
  const narrow = useIsNarrow();
  const open = ctx.panel.name === "comments";
  return (
    <Sheet open={open} onOpenChange={(next) => !next && ctx.closePanel()}>
      <SheetContent
        side={narrow ? "bottom" : "right"}
        title={t("comment.title")}
        closeLabel={t("common.close")}
      >
        {open ? <CommentsBody /> : null}
      </SheetContent>
    </Sheet>
  );
}

function captureDraft(ctx: ReturnType<typeof useEditor>): Draft | null {
  const view = ctx.viewRef.current;
  if (!view) return null;
  const main = view.state.selection.main;
  const ytext = fileText(ctx.doc, ctx.activeFile.id);
  const toRel = (index: number) =>
    Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index));
  const line = view.state.doc.lineAt(main.head).number;
  return {
    fileId: ctx.activeFile.id,
    anchor: toRel(main.anchor),
    head: toRel(main.head),
    line,
    quote: view.state.sliceDoc(main.from, Math.min(main.to, main.from + 80)),
  };
}

function CommentsBody() {
  const t = useT();
  const [locale] = useLocale();
  const ctx = useEditor();
  const comments = useComments(ctx.doc);
  const [showResolved, setShowResolved] = useState(false);
  const [draft] = useState<Draft | null>(() => (ctx.readOnly ? null : captureDraft(ctx)));
  const [body, setBody] = useState("");
  const [missing, setMissing] = useState(false);
  const focusId = ctx.panel.arg;
  const focusRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const visible = comments
    .filter((comment) => showResolved || !comment.resolved)
    .sort((a, b) => a.createdAt - b.createdAt);
  const resolvedCount = comments.filter((comment) => comment.resolved).length;

  const post = () => {
    const text = body.trim();
    if (!draft) return;
    if (!text) {
      setMissing(true);
      return;
    }
    addComment(ctx.doc, {
      id: newCommentId(),
      fileId: draft.fileId,
      anchor: draft.anchor as Comment["anchor"],
      head: draft.head as Comment["head"],
      author: ctx.me,
      body: text,
      createdAt: Date.now(),
      resolved: false,
    });
    setBody("");
  };

  const jump = (comment: Comment) => {
    const range = commentRange(comment, ctx.doc, fileText(ctx.doc, comment.fileId));
    ctx.closePanel();
    ctx.setActiveFileId(comment.fileId);
    if (!range) return;
    window.setTimeout(() => {
      const view = ctx.viewRef.current;
      if (!view) return;
      const from = Math.min(range.from, view.state.doc.length);
      const to = Math.min(range.to, view.state.doc.length);
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
    }, 60);
  };

  const lineOf = (comment: Comment): number | null => {
    const range = commentRange(comment, ctx.doc, fileText(ctx.doc, comment.fileId));
    if (!range) return null;
    const text = fileText(ctx.doc, comment.fileId).toString();
    return text.slice(0, range.from).split("\n").length;
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {!ctx.readOnly && draft ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            post();
          }}
        >
          <label htmlFor="comment-body" className="text-label font-medium">
            {t("comment.onLine", { line: draft.line })}
          </label>
          {draft.quote ? (
            <blockquote className="truncate rounded-md border-s-2 border-line-strong bg-fill-hover px-2 py-1 font-mono text-caption text-fg-2">
              {draft.quote}
            </blockquote>
          ) : null}
          <textarea
            id="comment-body"
            value={body}
            maxLength={MAX_COMMENT_LENGTH}
            rows={3}
            placeholder={t("comment.placeholder")}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? "comment-error" : undefined}
            onChange={(event) => {
              setBody(event.target.value);
              setMissing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                post();
              }
            }}
            data-testid="comment-input"
            className="w-full resize-y rounded-md border border-line-control bg-panel p-2 text-body-sm focus:border-accent-text aria-invalid:border-danger-text coarse:text-base"
          />
          {missing ? (
            <p id="comment-error" role="alert" className="text-caption text-danger-text">
              {t("comment.bodyRequired")}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="self-end"
            data-testid="comment-post"
          >
            {t("comment.postAction")}
          </Button>
        </form>
      ) : null}

      {resolvedCount > 0 ? (
        <Switch
          // A switch is named for its on state; a label that flips with it reads as a double negative.
          label={`${t("comment.showResolved")} (${resolvedCount})`}
          checked={showResolved}
          onCheckedChange={setShowResolved}
        />
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<MessageSquare />}
          title={t("comment.empty.title")}
          description={t("comment.empty.body")}
        />
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="comment-list">
          {visible.map((comment) => {
            const line = lineOf(comment);
            const mine = comment.author.clientId === ctx.me.clientId;
            return (
              <li
                key={comment.id}
                ref={comment.id === focusId ? focusRef : undefined}
                data-testid="comment"
                className={`flex flex-col gap-2 rounded-lg border p-3 ${
                  comment.id === focusId ? "border-accent-text bg-accent-soft" : "border-line"
                } ${comment.resolved ? "opacity-70" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <Avatar
                    name={comment.author.name}
                    slot={1}
                    size="xs"
                    style={{
                      backgroundColor: comment.author.color,
                      color: labelColorFor(comment.author.color),
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                    {comment.author.name}
                  </span>
                  <time
                    dateTime={new Date(comment.createdAt).toISOString()}
                    className="text-caption text-fg-3"
                  >
                    {formatRelativeTime(locale, comment.createdAt - Date.now())}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-body-sm">{comment.body}</p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => jump(comment)}
                    className="min-w-0 truncate rounded text-caption text-accent-text underline-offset-2 hover:underline"
                  >
                    {line === null ? t("comment.anchorLost") : t("comment.onLine", { line })}
                  </button>
                  <span className="ms-auto flex gap-1">
                    {!ctx.readOnly || ctx.isOwner ? (
                      <IconButton
                        aria-label={
                          comment.resolved ? t("comment.reopenAction") : t("comment.resolveAction")
                        }
                        size="xs"
                        onClick={() =>
                          updateComment(ctx.doc, comment.id, { resolved: !comment.resolved })
                        }
                        data-testid="comment-resolve"
                      >
                        {comment.resolved ? <RotateCcw /> : <Check />}
                      </IconButton>
                    ) : null}
                    {mine || ctx.isOwner ? (
                      <IconButton
                        aria-label={t("comment.deleteAction")}
                        size="xs"
                        onClick={() => {
                          deleteComment(ctx.doc, comment.id);
                          toast({
                            title: t("toast.commentDeleted"),
                            tone: "neutral",
                            action: {
                              label: t("common.undo"),
                              altText: t("common.undo"),
                              onClick: () => addComment(ctx.doc, comment),
                            },
                          });
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
