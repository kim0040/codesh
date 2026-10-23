import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import type { DocSession } from "../../../lib/collab/session";

/** Publishes my file, cursor and viewport (docs/ARCHITECTURE.md §4); `session.publish` throttles. */

export function visibleLines(view: EditorView): { fromLine: number; toLine: number } {
  const top = view.scrollDOM.scrollTop;
  const first = view.lineBlockAtHeight(top);
  const last = view.lineBlockAtHeight(top + view.scrollDOM.clientHeight);
  return {
    fromLine: view.state.doc.lineAt(first.from).number,
    toLine: view.state.doc.lineAt(Math.min(last.from, view.state.doc.length)).number,
  };
}

export function awarenessBridge(session: DocSession, fileId: string) {
  return ViewPlugin.fromClass(
    class {
      private readonly onScroll: () => void;

      constructor(private readonly view: EditorView) {
        session.publish({ fileId });
        this.sendCursor();
        this.sendViewport();
        this.onScroll = () => this.sendViewport();
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      }

      update(update: ViewUpdate) {
        if (update.selectionSet || update.docChanged) this.sendCursor();
        if (update.geometryChanged || update.viewportChanged) this.sendViewport();
      }

      sendCursor() {
        const config = this.view.state.facet(ySyncFacet);
        const main = this.view.state.selection.main;
        session.publish({
          cursor: {
            anchor: Y.relativePositionToJSON(config.toYPos(main.anchor, main.assoc)),
            head: Y.relativePositionToJSON(config.toYPos(main.head, main.assoc)),
          },
        });
      }

      sendViewport() {
        session.publish({ viewport: visibleLines(this.view) });
      }

      destroy() {
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        session.publish({ cursor: undefined, viewport: undefined });
      }
    },
  );
}
