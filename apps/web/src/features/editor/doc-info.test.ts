import { describe, expect, it } from "vitest";
import { createInfoStore, setInitialLength, showAloneHint } from "./doc-info";

describe("setInitialLength", () => {
  it("fills the length of a document that was loaded with content", () => {
    const info = createInfoStore();
    expect(info.get().length).toBe(0);
    setInitialLength(info, 412);
    expect(info.get()).toEqual({ line: 1, col: 1, selected: 0, length: 412, bytes: 0 });
  });

  it("keeps the other fields and notifies subscribers once", () => {
    const info = createInfoStore();
    info.set({ line: 4, col: 2, selected: 3, length: 0, bytes: 9 });
    let calls = 0;
    info.subscribe(() => {
      calls += 1;
    });
    setInitialLength(info, 20);
    expect(info.get()).toEqual({ line: 4, col: 2, selected: 3, length: 20, bytes: 9 });
    expect(calls).toBe(1);
  });
});

describe("showAloneHint", () => {
  it("shows for an empty editable share with one participant", () => {
    expect(showAloneHint({ participants: 1, length: 0, readOnly: false })).toBe(true);
  });

  it("stays hidden once the file has content, before any cursor move", () => {
    const info = createInfoStore();
    setInitialLength(info, 300);
    expect(showAloneHint({ participants: 1, length: info.get().length, readOnly: false })).toBe(
      false,
    );
  });

  it("stays hidden with company or in read-only mode", () => {
    expect(showAloneHint({ participants: 2, length: 0, readOnly: false })).toBe(false);
    expect(showAloneHint({ participants: 1, length: 0, readOnly: true })).toBe(false);
  });
});
