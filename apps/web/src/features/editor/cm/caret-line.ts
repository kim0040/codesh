import { type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * `highlightActiveLine` without the lines that hold a selection. CodeMirror draws selections in a
 * layer behind the text, so the line background hid the text the user was dragging over on that
 * line, while other participants still saw it. The theme's line colour is translucent as well, so
 * remote selections stay visible on the caret's line.
 */

const caretLine = Decoration.line({ class: "cm-activeLine" });

/** Start offsets of the lines to highlight: lines with an empty cursor and no selected text. */
export function caretLineStarts(state: EditorState): number[] {
  const { ranges } = state.selection;
  // Ranges are sorted and never overlap, so the selected ones are ordered by both ends.
  const selected = ranges.filter((range) => !range.empty);
  const starts: number[] = [];
  let next = 0;
  for (const range of ranges) {
    if (!range.empty) continue;
    const line = state.doc.lineAt(range.head);
    if (starts.length > 0 && starts[starts.length - 1] === line.from) continue;
    // A selection that ends where this line starts covers nothing on it.
    for (let s = selected[next]; s && s.to <= line.from && s.from < line.from; s = selected[next]) {
      next++;
    }
    const overlap = selected[next];
    if (overlap && overlap.from <= line.to) continue;
    starts.push(line.from);
  }
  return starts;
}

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const from of caretLineStarts(state)) builder.add(from, from, caretLine);
  return builder.finish();
}

export function caretLineHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view.state);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) this.decorations = build(update.state);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
