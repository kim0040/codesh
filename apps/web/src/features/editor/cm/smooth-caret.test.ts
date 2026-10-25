import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ySyncAnnotation } from "y-codemirror.next";
import { glides, localCaretActivity } from "./smooth-caret";

const state = EditorState.create({ doc: "one\ntwo\nthree\nfour\nfive" });

describe("caret transaction intent", () => {
  for (const event of ["input.type", "delete.backward", "delete.forward", "select.motion"]) {
    it(`glides and restarts for local ${event}`, () => {
      const tr = state.update({ selection: { anchor: 1 }, userEvent: event });
      expect(localCaretActivity(tr)).toBe(true);
      expect(glides(tr)).toBe(true);
    });
  }

  for (const event of [
    "select.pointer",
    "input.paste",
    "input.drop",
    "input.type.compose",
    "undo",
    "redo",
  ]) {
    it(`snaps for ${event}`, () => {
      expect(glides(state.update({ selection: { anchor: 1 }, userEvent: event }))).toBe(false);
    });
  }

  it("does not restart for remote Yjs changes even if a selection or input annotation is present", () => {
    const tr = state.update({
      changes: { from: 0, insert: "remote" },
      selection: { anchor: 6 },
      userEvent: "input.type",
      annotations: ySyncAnnotation.of({} as never),
    });
    expect(localCaretActivity(tr)).toBe(false);
    expect(glides(tr)).toBe(false);
  });

  it("does not restart for generic remote or programmatic edits", () => {
    for (const tr of [
      state.update({
        changes: { from: 0, insert: "remote" },
        annotations: Transaction.remote.of(true),
      }),
      state.update({ changes: { from: 0, insert: "programmatic" } }),
      state.update({}),
    ]) {
      expect(localCaretActivity(tr)).toBe(false);
      expect(glides(tr)).toBe(false);
    }
  });

  it("restarts for local input without an explicit selection and for a programmatic selection", () => {
    expect(
      localCaretActivity(
        state.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }),
      ),
    ).toBe(true);
    expect(localCaretActivity(state.update({ selection: { anchor: 2 } }))).toBe(true);
  });
});
