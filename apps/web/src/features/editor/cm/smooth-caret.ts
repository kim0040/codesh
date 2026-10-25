import { EditorSelection, type Extension, type Transaction } from "@codemirror/state";
import {
  EditorView,
  type LayerMarker,
  layer,
  RectangleMarker,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Smooth typing: the main cursor glides to its next place, the way Word's caret follows typing.
 * It is drawn in its own layer and moved with a CSS transform, so the compositor animates it and
 * layout never reruns; CodeMirror's own main cursor is hidden while this is on (editor.css). Typing,
 * deleting and keyboard moves glide; clicks, pastes, undo, remote edits, resizes and jumps of more
 * than a few lines snap. So does everything while an IME composes: the caret must not animate under
 * a candidate window. Under `prefers-reduced-motion` the CSS drops the transition. The layer is
 * not a `.cm-cursorLayer`, so `.cm-cursorLayer .cm-cursor` still counts the selections; editor.css
 * shows and blinks it the way CodeMirror does its own.
 */

/** Vertical distance, in lines, up to which the cursor glides; a longer move jumps. */
const GLIDE_MAX_LINES = 3;

/** Moves that read as typing or stepping through the text, never jumps the user did not make. */
function glides(tr: Transaction): boolean {
  if (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) return false;
  if (tr.isUserEvent("select.pointer")) return false;
  if (tr.isUserEvent("input.type.compose")) return false;
  return tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("select");
}

class GlidingCaret implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly glide: boolean,
  ) {}

  eq(other: GlidingCaret): boolean {
    return this.left === other.left && this.top === other.top && this.height === other.height;
  }

  draw(): HTMLElement {
    const caret = document.createElement("div");
    // `cm-cursor` takes the theme's colour and width; the transform replaces left/top.
    caret.className = "cm-cursor cm-smooth-caret";
    this.place(caret, false);
    return caret;
  }

  update(dom: HTMLElement, old: LayerMarker): boolean {
    const previous = old as GlidingCaret;
    const far = Math.abs(this.top - previous.top) > GLIDE_MAX_LINES * Math.max(this.height, 1);
    this.place(dom, this.glide && !far);
    return true;
  }

  private place(caret: HTMLElement, glide: boolean) {
    // An inline `none` snaps; otherwise the transition in editor.css (or none, reduced) applies.
    caret.style.transition = glide ? "" : "none";
    caret.style.transform = `translate3d(${this.left}px, ${this.top}px, 0)`;
    caret.style.height = `${this.height}px`;
  }
}

export function smoothCaret(): Extension {
  // Set by each update for the markers measured after it.
  let glide = false;
  const caretLayer = layer({
    above: true,
    class: "cm-smooth-caret-layer",
    markers(view) {
      const main = view.state.selection.main;
      const [rect] = RectangleMarker.forRange(
        view,
        "",
        EditorSelection.cursor(main.head, main.assoc),
      );
      if (!rect) return [];
      return [new GlidingCaret(rect.left, rect.top, rect.height, glide)];
    },
    update(update: ViewUpdate, dom: HTMLElement) {
      const moved = update.docChanged || update.selectionSet;
      // An update that leaves the cursor alone (a status change, a decoration) keeps how the last
      // move goes, unless the layout moved; it lands before the measure of that move.
      if (moved || update.geometryChanged) {
        glide =
          moved &&
          update.transactions.length > 0 &&
          !update.view.composing &&
          update.transactions.every(glides) &&
          !(update.geometryChanged && !update.docChanged);
      }
      // Like CodeMirror's own cursor: a move restarts the blink, visible, by switching animations.
      if (update.transactions.some((tr) => tr.selection || tr.docChanged)) {
        dom.style.animationName =
          dom.style.animationName === "cm-smooth-blink" ? "cm-smooth-blink2" : "cm-smooth-blink";
      }
      return update.docChanged || update.selectionSet;
    },
  });
  return [caretLayer, EditorView.editorAttributes.of({ "data-smooth-typing": "on" })];
}
