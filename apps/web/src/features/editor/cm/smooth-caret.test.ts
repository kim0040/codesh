import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { ySyncAnnotation } from "y-codemirror.next";
import { GlidingCaret, glides, hangulStep, localCaretActivity } from "./smooth-caret";

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

describe("caret during IME composition", () => {
  // A composition is applied to the document as it goes: each step swaps the composing text.
  const composing = (doc: string, at: number, from: number, insert: string, userEvent: string) =>
    EditorState.create({ doc, selection: { anchor: at } }).update({
      changes: { from, to: at, insert },
      selection: { anchor: from + insert.length },
      userEvent,
    });

  it("glides when a Hangul composition moves on to the next syllable", () => {
    for (const userEvent of ["input.type.compose", "input.type.compose.start"]) {
      // first jamo of a syllable, after the text already there
      const next = composing("한", 1, 1, "ㄱ", userEvent);
      expect(hangulStep(next)).toBe(true);
      expect(glides(next)).toBe(true);
      // a syllable that splits into a finished one and a new composing one
      expect(glides(composing("각", 1, 0, "가가", userEvent))).toBe(true);
    }
  });

  it("snaps while jamo join the syllable the cursor is already on", () => {
    for (const { before, after } of [
      { before: "ㅎ", after: "하" },
      { before: "하", after: "한" },
      { before: "한", after: "하" },
    ]) {
      const step = composing(before, 1, 0, after, "input.type.compose");
      expect(hangulStep(step)).toBe(false);
      expect(glides(step)).toBe(false);
    }
  });

  it("snaps for compositions that show a candidate window", () => {
    for (const { doc, insert } of [
      { doc: "", insert: "か" }, // Japanese kana
      { doc: "か", insert: "かん" },
      { doc: "", insert: "ni" }, // pinyin letters
      { doc: "ni", insert: "你" }, // Chinese
      { doc: "한", insert: "韓" }, // Hanja chosen from the candidates
      { doc: "", insert: "한a" }, // Hangul mixed with other text
    ]) {
      const at = doc.length;
      const step = composing(doc, at, at, insert, "input.type.compose");
      expect(hangulStep(step)).toBe(false);
      expect(glides(step)).toBe(false);
    }
  });

  it("snaps for a composition step that inserts nothing", () => {
    expect(glides(composing("한", 1, 0, "", "input.type.compose"))).toBe(false);
  });

  it("still snaps for Hangul that is pasted or arrives from a remote edit", () => {
    expect(glides(composing("한", 1, 1, "ㄱ", "input.paste"))).toBe(false);
    const remote = EditorState.create({ doc: "한" }).update({
      changes: { from: 1, insert: "ㄱ" },
      selection: { anchor: 2 },
      userEvent: "input.type.compose",
      annotations: Transaction.remote.of(true),
    });
    expect(glides(remote)).toBe(false);
  });
});

describe("caret during decomposed and extended jamo composition", () => {
  const composing = (doc: string, at: number, from: number, insert: string) =>
    EditorState.create({ doc, selection: { anchor: at } }).update({
      changes: { from, to: at, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input.type.compose",
    });
  // han as conjoining jamo: leading U+1112, vowel U+1161, trailing U+11AB
  const [h, a, n] = ["\u1112", "\u1161", "\u11ab"];

  it("glides for the first jamo and snaps while the same syllable grows jamo by jamo", () => {
    expect(glides(composing("", 0, 0, h))).toBe(true);
    // the cursor moves with every jamo, but the syllable under it does not change
    expect(glides(composing(h, 1, 0, h + a))).toBe(false);
    expect(glides(composing(h + a, 2, 0, h + a + n))).toBe(false);
    expect(glides(composing(h + a, 2, 2, n))).toBe(false);
    // a precomposed syllable takes a trailing jamo the same way
    expect(glides(composing("\ud558", 1, 1, n))).toBe(false);
  });

  it("glides when the next syllable starts, after the last one or by splitting it", () => {
    const next = "\u1102";
    expect(glides(composing(h + a + n, 3, 3, next))).toBe(true);
    expect(glides(composing("\ud55c", 1, 1, next))).toBe(true);
    // the final jamo moves on as the leading jamo of the next syllable
    expect(glides(composing(h + a + n, 3, 2, next + a))).toBe(true);
  });

  it("treats the extended jamo blocks like the main ones", () => {
    const [leading, vowel, trailing] = ["\ua960", "\ud7b0", "\ud7cb"];
    expect(glides(composing("", 0, 0, leading))).toBe(true);
    expect(glides(composing(leading, 1, 0, leading + vowel))).toBe(false);
    expect(glides(composing(leading + vowel, 2, 0, leading + vowel + trailing))).toBe(false);
    expect(glides(composing(leading + vowel + trailing, 3, 3, "\u1100"))).toBe(true);
  });
});

describe("gliding caret marker", () => {
  it("is not equal to one at the same place that moves differently", () => {
    expect(new GlidingCaret(10, 4, 16, true).eq(new GlidingCaret(10, 4, 16, true))).toBe(true);
    expect(new GlidingCaret(10, 4, 16, true).eq(new GlidingCaret(10, 4, 16, false))).toBe(false);
    expect(new GlidingCaret(10, 4, 16, false).eq(new GlidingCaret(11, 4, 16, false))).toBe(false);
  });
});
