import { describe, expect, it } from "vitest";
import { createFocusReturn, type Focusable } from "./focus-return";

function element(isConnected = true) {
  const calls: string[] = [];
  const el: Focusable & { calls: string[]; isConnected: boolean } = {
    calls,
    isConnected,
    focus: () => calls.push("focus"),
  };
  return el;
}

function event(defaultPrevented = false) {
  const e = {
    defaultPrevented,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  return e;
}

describe("createFocusReturn", () => {
  it("focuses the element that had focus when the panel opened", () => {
    const opener = element();
    const ret = createFocusReturn(() => opener);
    ret.onOpenAutoFocus(event());
    const close = event();
    ret.onCloseAutoFocus(close);
    expect(opener.calls).toEqual(["focus"]);
    expect(close.defaultPrevented).toBe(true);
  });

  it("returns focus once per open", () => {
    const opener = element();
    const ret = createFocusReturn(() => opener);
    ret.onOpenAutoFocus(event());
    ret.onCloseAutoFocus(event());
    ret.onCloseAutoFocus(event());
    expect(opener.calls).toEqual(["focus"]);
  });

  it("uses the element from the latest open", () => {
    const first = element();
    const second = element();
    let current = first;
    const ret = createFocusReturn(() => current);
    ret.onOpenAutoFocus(event());
    ret.onCloseAutoFocus(event());
    current = second;
    ret.onOpenAutoFocus(event());
    ret.onCloseAutoFocus(event());
    expect(first.calls).toEqual(["focus"]);
    expect(second.calls).toEqual(["focus"]);
  });

  it("leaves Radix's default in place when nothing had focus", () => {
    const ret = createFocusReturn(() => null);
    ret.onOpenAutoFocus(event());
    const close = event();
    ret.onCloseAutoFocus(close);
    expect(close.defaultPrevented).toBe(false);
  });

  it("does not focus an element that left the document", () => {
    const opener = element(false);
    const ret = createFocusReturn(() => opener);
    ret.onOpenAutoFocus(event());
    const close = event();
    ret.onCloseAutoFocus(close);
    expect(opener.calls).toEqual([]);
    expect(close.defaultPrevented).toBe(false);
  });

  it("respects a close handler that already took over focus", () => {
    const opener = element();
    const ret = createFocusReturn(() => opener);
    ret.onOpenAutoFocus(event());
    ret.onCloseAutoFocus(event(true));
    expect(opener.calls).toEqual([]);
  });
});
