import { describe, expect, it } from "vitest";
import { DEFAULT_TOAST_DURATION, toastDuration } from "./toast-duration";

describe("toastDuration", () => {
  it("uses the default for plain toasts", () => {
    expect(toastDuration({})).toBe(DEFAULT_TOAST_DURATION);
    expect(toastDuration({ tone: "success" })).toBe(DEFAULT_TOAST_DURATION);
    expect(toastDuration({ tone: "info" })).toBe(DEFAULT_TOAST_DURATION);
  });

  it("keeps error toasts until they are dismissed", () => {
    expect(toastDuration({ tone: "danger" })).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps toasts with an action until they are dismissed", () => {
    const action = { label: "Accept", altText: "Accept", onClick: () => {} };
    expect(toastDuration({ tone: "info", action })).toBe(Number.POSITIVE_INFINITY);
    expect(toastDuration({ tone: "warning", action })).toBe(Number.POSITIVE_INFINITY);
  });

  it("lets an explicit duration win over the tone rule", () => {
    expect(toastDuration({ tone: "danger", duration: 8000 })).toBe(8000);
    expect(toastDuration({ tone: "success", duration: 2000 })).toBe(2000);
  });
});
