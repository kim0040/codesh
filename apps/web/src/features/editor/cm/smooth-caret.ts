import { EditorSelection, type Extension, type Text, Transaction } from "@codemirror/state";
import {
  EditorView,
  type LayerMarker,
  layer,
  RectangleMarker,
  type ViewUpdate,
} from "@codemirror/view";
import { ySyncAnnotation } from "y-codemirror.next";

/**
 * Smooth typing: the main cursor glides to its next place, the way Word's caret follows typing.
 * It is drawn in its own layer and moved with a CSS transform, so the compositor animates it and
 * layout never reruns; CodeMirror's own main cursor is hidden while this is on (editor.css). Typing,
 * deleting and keyboard moves glide; clicks, pastes, undo, remote edits, resizes and jumps of more
 * than a few lines snap. So does everything while an IME composes, except Hangul: its syllables are
 * composed for nearly every keystroke, with no candidate window, so the caret glides when a
 * composition carries it to the next syllable and stays put while jamo join the one it is on.
 * Japanese, Chinese and Hanja composition snap: the caret must not animate under a candidate
 * window. Under `prefers-reduced-motion` the CSS drops the transition. The layer is
 * not a `.cm-cursorLayer`, so `.cm-cursorLayer .cm-cursor` still counts the selections; editor.css
 * shows and blinks it the way CodeMirror does its own.
 */

/** Vertical distance, in lines, up to which the cursor glides; a longer move jumps. */
const GLIDE_MAX_LINES = 3;

/** Hangul syllables and jamo: the compatibility block, the conjoining blocks and their extensions. */
const HANGUL = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]+$/;

/** Yjs maps our selection through remote edits without an explicit local selection move. */
export function localCaretActivity(tr: Transaction): boolean {
  if (tr.annotation(ySyncAnnotation) || tr.annotation(Transaction.remote)) return false;
  return (
    Boolean(tr.selection) ||
    (tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete")))
  );
}

/** Moves that read as typing or stepping through the text, never jumps the user did not make. */
export function glides(tr: Transaction): boolean {
  if (!localCaretActivity(tr)) return false;
  if (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) return false;
  if (tr.isUserEvent("select.pointer")) return false;
  if (tr.isUserEvent("input.type.compose")) return hangulStep(tr);
  return tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("select");
}

/**
 * A composition step that only inserts Hangul and starts a new syllable: the first jamo after
 * committed text, or a syllable that splits into a finished one and the next. Jamo joining the
 * syllable already there leave the cursor on it and only change its width, so that stays a snap.
 * Judged by the composed text, not by the UI language or the keyboard layout, and by where the
 * syllable under the cursor starts, not by how far the cursor moved: decomposed jamo advance the
 * cursor with every one of them.
 */
export function hangulStep(tr: Transaction): boolean {
  if (!tr.docChanged || tr.newSelection.main.head === tr.startState.selection.main.head) {
    return false;
  }
  let hangul = true;
  tr.changes.iterChanges((_from, _to, _fromB, _toB, inserted) => {
    if (!HANGUL.test(inserted.toString())) hangul = false;
  });
  return hangul && hangulSyllableStep(tr);
}

function hangulSyllableStep(tr: Transaction): boolean {
  const oldHead = tr.startState.selection.main.head;
  const oldStart = syllableStart(tr.startState.doc, oldHead);
  const appended = mapAppendedSyllableStart(tr, oldHead, oldStart);
  if (appended !== undefined) return appended;
  const newStart = syllableStart(tr.newDoc, tr.newSelection.main.head);
  if (newStart === null) return false;
  // An unknown old start means no syllable began in the last SYLLABLE_READ_LIMIT characters before
  // the caret, so a start found in that window is a real new syllable.
  if (oldStart === null) return newStart > oldHead - SYLLABLE_READ_LIMIT;
  return oldStart !== newStart;
}

/** Characters read at a time when walking back to where a syllable starts. */
const SYLLABLE_CHUNK = 16;
/** Maximum uncached text read to find a syllable start. */
const SYLLABLE_READ_LIMIT = 128;

type SyllableStart = number | null;

/** A document version and head do not change; later composing transactions can reuse this result. */
const syllableStarts = new WeakMap<Text, Map<number, SyllableStart>>();

/** Position where the syllable ending at `head` starts, or null when the start is not known. */
function syllableStart(doc: Text, head: number): SyllableStart {
  const cached = syllableStarts.get(doc)?.get(head);
  if (cached !== undefined) return cached;

  let start = head - 1;
  let remaining = SYLLABLE_READ_LIMIT;
  while (start > 0) {
    const span = Math.min(SYLLABLE_CHUNK, remaining - 1);
    if (span < 1) return rememberSyllableStart(doc, head, null);
    const from = Math.max(0, start - span);
    const text = doc.sliceString(from, start + 1);
    remaining -= text.length;
    let i = text.length - 1;
    while (i > 0 && joins(text.charCodeAt(i - 1), text.charCodeAt(i))) i--;
    start = from + i;
    if (i > 0 || from === 0) return rememberSyllableStart(doc, head, start);
  }
  return rememberSyllableStart(doc, head, start);
}

function rememberSyllableStart(doc: Text, head: number, start: SyllableStart): SyllableStart {
  let starts = syllableStarts.get(doc);
  if (!starts) {
    starts = new Map();
    syllableStarts.set(doc, starts);
  }
  starts.set(head, start);
  return start;
}

/**
 * Carry the current boundary through a small append at the caret. This keeps repeated composition
 * edits incremental, including when the old cluster was too long to find within the read limit.
 */
function mapAppendedSyllableStart(
  tr: Transaction,
  oldHead: number,
  oldStart: SyllableStart,
): boolean | undefined {
  const newHead = tr.newSelection.main.head;
  let count = 0;
  let isAppend = false;
  let startsNewSyllable = false;
  let mappedStart: SyllableStart = oldStart;

  tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
    count++;
    if (
      from !== oldHead ||
      to !== oldHead ||
      fromB !== oldHead ||
      toB !== newHead ||
      inserted.length === 0 ||
      inserted.length > SYLLABLE_READ_LIMIT
    ) {
      return;
    }

    isAppend = true;
    const text = inserted.toString();
    let previous =
      oldHead > 0 ? tr.startState.doc.sliceString(oldHead - 1, oldHead).charCodeAt(0) : undefined;
    if (previous === undefined) {
      mappedStart = oldHead;
      startsNewSyllable = true;
    }
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (previous !== undefined && !joins(previous, code)) {
        mappedStart = oldHead + i;
        startsNewSyllable = true;
      }
      previous = code;
    }
  });

  if (count !== 1 || !isAppend) return undefined;
  rememberSyllableStart(tr.newDoc, newHead, mappedStart);
  return startsNewSyllable;
}

/** Role of a Hangul code in a syllable: leading, vowel or trailing jamo, or a whole syllable. */
function jamoKind(code: number): "L" | "V" | "T" | "LV" | "LVT" | undefined {
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return "L";
  if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return "V";
  if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return "T";
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return undefined;
}

/** Whether `next` continues the syllable `previous` ends (the Unicode Hangul cluster rules). */
function joins(previous: number, next: number): boolean {
  const a = jamoKind(previous);
  const b = jamoKind(next);
  if (a === "L") return b === "L" || b === "V" || b === "LV" || b === "LVT";
  if (a === "LV" || a === "V") return b === "V" || b === "T";
  if (a === "LVT" || a === "T") return b === "T";
  return false;
}

export class GlidingCaret implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly glide: boolean,
  ) {}

  eq(other: GlidingCaret): boolean {
    // The way it moves counts too: a snap to the spot a running glide is heading for must still
    // cut that glide short.
    return (
      this.left === other.left &&
      this.top === other.top &&
      this.height === other.height &&
      this.glide === other.glide
    );
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
  // The first measure after a composition step glides only if it found the cursor somewhere new.
  let composeStep = false;
  let spot: { left: number; top: number } | undefined;
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
      // While composing, the browser can report the new text late: an empty or unmoved rect means
      // the measure came before the layout. Snap to it, and to the corrected one that follows.
      if (composeStep) {
        composeStep = false;
        if (rect.height <= 0 || (spot?.left === rect.left && spot.top === rect.top)) glide = false;
      }
      spot = { left: rect.left, top: rect.top };
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
          (!update.view.composing || update.transactions.every(hangulStep)) &&
          update.transactions.every(glides) &&
          !(update.geometryChanged && !update.docChanged);
        composeStep = glide && update.view.composing;
      }
      // Restart fully visible only for our input/moves. Remote Yjs changes must keep the rhythm.
      // Rapid typing keeps restarting the opaque part of the cycle, so the caret stays solid.
      if (update.transactions.some(localCaretActivity)) {
        dom.style.setProperty(
          "--caret-blink",
          dom.style.getPropertyValue("--caret-blink") === "cm-smooth-blink2"
            ? "cm-smooth-blink"
            : "cm-smooth-blink2",
        );
      }
      return update.docChanged || update.selectionSet;
    },
  });
  return [caretLayer, EditorView.editorAttributes.of({ "data-smooth-typing": "on" })];
}
