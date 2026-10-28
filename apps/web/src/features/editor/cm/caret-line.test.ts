import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { caretLineStarts } from "./caret-line";

const doc = "alpha\nbeta\ngamma\ndelta";
const at = (...ranges: [number, number][]) =>
  EditorState.create({
    doc,
    extensions: EditorState.allowMultipleSelections.of(true),
    selection: EditorSelection.create(
      ranges.map(([anchor, head]) => EditorSelection.range(anchor, head)),
    ),
  });

describe("caret line highlight", () => {
  it("highlights the line of an empty cursor", () => {
    expect(caretLineStarts(at([8, 8]))).toEqual([6]);
  });

  it("leaves a line with selected text unhighlighted so the selection shows", () => {
    expect(caretLineStarts(at([1, 4]))).toEqual([]);
    expect(caretLineStarts(at([4, 1]))).toEqual([]);
    expect(caretLineStarts(at([2, 13]))).toEqual([]);
  });

  it("keeps other cursors' lines when one cursor selects text", () => {
    expect(caretLineStarts(at([1, 3], [8, 8], [19, 19]))).toEqual([6, 17]);
  });

  it("skips a cursor line that another range selects on", () => {
    expect(caretLineStarts(at([6, 6], [8, 10]))).toEqual([]);
  });

  it("highlights the line after a selection that ends at its start", () => {
    expect(caretLineStarts(at([0, 6], [8, 8]))).toEqual([6]);
  });

  it("lists each line once for several cursors on it", () => {
    expect(caretLineStarts(at([6, 6], [8, 8], [10, 10]))).toEqual([6]);
  });
});
