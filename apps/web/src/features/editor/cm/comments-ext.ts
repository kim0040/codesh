import { type Extension, RangeSet, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { Comment } from "@gachipad/shared";
import { YDOC } from "@gachipad/shared";
import * as Y from "yjs";
import type { DocSession } from "../../../lib/collab/session";

export const refreshComments = StateEffect.define<null>();

function absolute(rel: unknown, doc: Y.Doc, ytext: Y.Text): number | null {
  if (!rel || typeof rel !== "object") return null;
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(rel),
      doc,
    );
    return position && position.type === ytext ? position.index : null;
  } catch {
    return null;
  }
}

/** Where a comment currently sits in this file; null when its text was deleted. */
export function commentRange(
  comment: Comment,
  doc: Y.Doc,
  ytext: Y.Text,
): { from: number; to: number } | null {
  const a = absolute(comment.anchor, doc, ytext);
  const b = absolute(comment.head, doc, ytext);
  if (a === null || b === null) return null;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

class CommentMarker extends GutterMarker {
  constructor(
    readonly ids: readonly string[],
    readonly label: string,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof CommentMarker && other.ids.join() === this.ids.join();
  }

  override toDOM(): Node {
    const dot = document.createElement("span");
    dot.className = "cm-comment-dot";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", this.label);
    dot.textContent = this.ids.length > 1 ? String(this.ids.length) : "";
    return dot;
  }
}

class Spacer extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-comment-spacer";
    return el;
  }
}

export interface CommentsExtensionOptions {
  session: DocSession;
  ytext: Y.Text;
  fileId: string;
  label: string;
  /** A gutter dot was clicked: the ids of the open comments on that line. */
  onOpen: (ids: string[]) => void;
}

/** Gutter dots and dotted underlines for open comments; relative positions keep them in place. */
export function commentsExtension(options: CommentsExtensionOptions): Extension {
  const { session, ytext, fileId, label, onOpen } = options;
  const array = () => session.doc.getArray<Comment>(YDOC.comments);

  const open = (): Comment[] => {
    const seen = new Map<string, Comment>();
    for (const comment of array().toArray()) {
      if (comment && comment.fileId === fileId && !comment.resolved) seen.set(comment.id, comment);
    }
    return [...seen.values()];
  };

  const gutterExtension = gutter({
    class: "cm-comment-gutter",
    initialSpacer: () => new Spacer(),
    markers(view) {
      const byLine = new Map<number, string[]>();
      for (const comment of open()) {
        const range = commentRange(comment, session.doc, ytext);
        if (!range) continue;
        const line = view.state.doc.lineAt(Math.min(range.from, view.state.doc.length));
        byLine.set(line.from, [...(byLine.get(line.from) ?? []), comment.id]);
      }
      const markers = [...byLine.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([from, ids]) => new CommentMarker(ids, label).range(from));
      return RangeSet.of(markers);
    },
    lineMarkerChange: (update) =>
      update.docChanged ||
      update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshComments))),
    domEventHandlers: {
      click(view, block) {
        const line = view.state.doc.lineAt(block.from);
        const ids: string[] = [];
        for (const comment of open()) {
          const range = commentRange(comment, session.doc, ytext);
          if (
            range &&
            view.state.doc.lineAt(Math.min(range.from, view.state.doc.length)).from === line.from
          ) {
            ids.push(comment.id);
          }
        }
        if (ids.length === 0) return false;
        onOpen(ids);
        return true;
      },
    },
  });

  const underline = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshComments)))
        ) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const ranges = [];
        for (const comment of open()) {
          const range = commentRange(comment, session.doc, ytext);
          if (!range || range.to <= range.from) continue;
          ranges.push(
            Decoration.mark({
              class: "cm-commented",
              attributes: { "data-comment": comment.id },
            }).range(
              Math.min(range.from, view.state.doc.length),
              Math.min(range.to, view.state.doc.length),
            ),
          );
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const watcher = ViewPlugin.define((view) => {
    const target = array();
    let frame = 0;
    const onChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        view.dispatch({ effects: refreshComments.of(null) });
      });
    };
    target.observeDeep(onChange);
    return {
      destroy() {
        target.unobserveDeep(onChange);
        if (frame) cancelAnimationFrame(frame);
      },
    };
  });

  return [gutterExtension, underline, watcher];
}
