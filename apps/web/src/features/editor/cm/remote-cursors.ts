import { EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView, type LayerMarker, layer, RectangleMarker, ViewPlugin } from "@codemirror/view";
import { contrastRatio, PARTICIPANT_COLORS } from "@codesh/highlight";
import type { AwarenessState } from "@codesh/shared";
import * as Y from "yjs";
import type { DocSession } from "../../../lib/collab/session";

/**
 * Remote cursors and selections drawn in CodeMirror layers instead of inline widgets. A layer
 * marker keeps its DOM element between updates, so moving a cursor only changes a CSS transform
 * and the browser animates it on the compositor (60 fps, no layout). The name flag fades in when
 * a person moves and out again when they go idle.
 */

export const refreshRemote = StateEffect.define<null>();

const INK = "#0a0c10";

const labelColors = new Map<string, string>();
/** Text colour for a flag filled with `hex`: from the palette, else whichever of white/ink reads. */
export function labelColorFor(hex: string): string {
  const key = hex.toLowerCase();
  const known = labelColors.get(key);
  if (known) return known;
  const fromPalette = PARTICIPANT_COLORS.find((c) => c.hex.toLowerCase() === key)?.label;
  const color =
    fromPalette ?? (contrastRatio("#ffffff", hex) >= contrastRatio(INK, hex) ? "#ffffff" : INK);
  labelColors.set(key, color);
  return color;
}

/** Until the fade starts (78% of the 3 s animation in editor.css), the flag is fully shown. */
const FLAG_SHOWN_MS = 2300;

interface Remote {
  awarenessId: number;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

function absolute(rel: unknown, doc: Y.Doc, ytext: Y.Text): number | null {
  if (!rel || typeof rel !== "object") return null;
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(rel),
      doc,
    );
    if (!position || position.type !== ytext) return null;
    return position.index;
  } catch {
    return null;
  }
}

export function collectRemotes(
  session: DocSession,
  ytext: Y.Text,
  fileId: string,
  length: number,
): Remote[] {
  const awareness = session.provider.awareness;
  if (!awareness) return [];
  const remotes: Remote[] = [];
  for (const [awarenessId, raw] of awareness.getStates()) {
    if (awarenessId === awareness.clientID) continue;
    const state = raw as Partial<AwarenessState>;
    if (!state.user || state.fileId !== fileId || !state.cursor) continue;
    const anchor = absolute(state.cursor.anchor, session.doc, ytext);
    const head = absolute(state.cursor.head, session.doc, ytext);
    if (anchor === null || head === null) continue;
    remotes.push({
      awarenessId,
      name: state.user.name,
      color: state.user.color,
      anchor: Math.min(anchor, length),
      head: Math.min(head, length),
    });
  }
  return remotes.sort((a, b) => a.awarenessId - b.awarenessId);
}

class CaretMarker implements LayerMarker {
  constructor(
    readonly id: number,
    readonly x: number,
    readonly y: number,
    readonly height: number,
    readonly color: string,
    readonly name: string,
  ) {}

  eq(other: CaretMarker): boolean {
    return (
      this.id === other.id &&
      this.x === other.x &&
      this.y === other.y &&
      this.height === other.height &&
      this.color === other.color &&
      this.name === other.name
    );
  }

  draw(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-remote-caret";
    const bar = document.createElement("div");
    bar.className = "cm-remote-caret-bar";
    const flag = document.createElement("div");
    flag.className = "cm-remote-caret-flag";
    root.append(bar, flag);
    this.apply(root);
    this.flash(root);
    return root;
  }

  update(dom: HTMLElement, old: LayerMarker): boolean {
    const previous = old as CaretMarker;
    // The layer updates every marker when one of them changes; the others stay as they are.
    if (this.eq(previous)) return true;
    this.apply(dom);
    if (previous.id !== this.id) this.flash(dom);
    else if (previous.x !== this.x || previous.y !== this.y) this.flash(dom);
    return true;
  }

  private apply(root: HTMLElement) {
    root.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
    root.style.height = `${this.height}px`;
    root.style.setProperty("--rc", this.color);
    root.style.setProperty("--rc-fg", labelColorFor(this.color));
    // On the first rows the flag would be clipped above the editor, so it hangs below instead.
    root.classList.toggle("is-top", this.y < 22);
    const flag = root.lastElementChild;
    if (flag && flag.textContent !== this.name) flag.textContent = this.name;
  }

  /**
   * Restarts the CSS animation that shows the name and fades it after a moment. A new animation
   * name restarts it without reading layout, so 50 moving carets cost no forced reflow; a flag
   * that is still showing stays opaque instead of fading in again on every keystroke.
   */
  private flash(root: HTMLElement) {
    const now = performance.now();
    const showing = now - Number(root.dataset.flashed ?? Number.NEGATIVE_INFINITY) < FLAG_SHOWN_MS;
    root.dataset.flashed = String(now);
    const next = root.dataset.flag === "a" ? "b" : "a";
    root.dataset.flag = next;
    root.dataset.flagFrom = showing ? "shown" : "hidden";
  }
}

class TintMarker implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly width: number,
    readonly height: number,
    readonly color: string,
  ) {}

  eq(other: TintMarker): boolean {
    return (
      this.left === other.left &&
      this.top === other.top &&
      this.width === other.width &&
      this.height === other.height &&
      this.color === other.color
    );
  }

  draw(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-remote-selection";
    this.apply(div);
    return div;
  }

  update(dom: HTMLElement): boolean {
    this.apply(dom);
    return true;
  }

  private apply(div: HTMLElement) {
    div.style.left = `${this.left}px`;
    div.style.top = `${this.top}px`;
    div.style.width = `${this.width}px`;
    div.style.height = `${this.height}px`;
    div.style.setProperty("--rc", this.color);
  }
}

function layerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const left =
    view.textDirection === 0 ? rect.left : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

function needsRedraw(update: import("@codemirror/view").ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshRemote)))
  );
}

export function remoteCursors(session: DocSession, ytext: Y.Text, fileId: string) {
  // Both layers draw from the same positions; resolving them is O(document) per cursor, so they
  // are resolved once per document state and awareness change, not once per layer.
  let version = 0;
  let cached: { doc: unknown; version: number; remotes: Remote[] } | null = null;
  const remotesOf = (view: EditorView): Remote[] => {
    if (cached?.doc !== view.state.doc || cached.version !== version) {
      cached = {
        doc: view.state.doc,
        version,
        remotes: collectRemotes(session, ytext, fileId, view.state.doc.length),
      };
    }
    return cached.remotes;
  };

  const selections = layer({
    above: false,
    class: "cm-remote-selections",
    update: needsRedraw,
    markers(view) {
      const markers: LayerMarker[] = [];
      for (const remote of remotesOf(view)) {
        if (remote.anchor === remote.head) continue;
        const range = EditorSelection.range(remote.anchor, remote.head);
        for (const rect of RectangleMarker.forRange(view, "", range)) {
          markers.push(
            new TintMarker(rect.left, rect.top, rect.width ?? 0, rect.height, remote.color),
          );
        }
      }
      return markers;
    },
  });

  const carets = layer({
    above: true,
    class: "cm-remote-carets",
    update: needsRedraw,
    markers(view) {
      const base = layerBase(view);
      const markers: LayerMarker[] = [];
      for (const remote of remotesOf(view)) {
        const coords = view.coordsAtPos(remote.head, remote.head > remote.anchor ? -1 : 1);
        if (!coords) continue;
        markers.push(
          new CaretMarker(
            remote.awarenessId,
            Math.round(((coords.left - base.left) / view.scaleX) * 10) / 10,
            Math.round(((coords.top - base.top) / view.scaleY) * 10) / 10,
            Math.max(14, (coords.bottom - coords.top) / view.scaleY),
            remote.color,
            remote.name,
          ),
        );
      }
      return markers;
    },
  });

  // Awareness changes arrive outside CodeMirror's update cycle: poke the layers once per frame.
  const watcher = ViewPlugin.define((view) => {
    const awareness = session.provider.awareness;
    let frame = 0;
    const onChange = () => {
      version++;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        view.dispatch({ effects: refreshRemote.of(null) });
      });
    };
    awareness?.on("change", onChange);
    return {
      destroy() {
        awareness?.off("change", onChange);
        if (frame) cancelAnimationFrame(frame);
      },
    };
  });

  return [selections, carets, watcher, remoteCursorTheme];
}

const remoteCursorTheme = EditorView.baseTheme({
  ".cm-remote-selections, .cm-remote-carets": { pointerEvents: "none" },
});
