import { describe, expect, it } from "vitest";
import { createT, DEFAULT_LOCALE, dictionaries, isLocale, LOCALES, t } from "./index.js";

describe("i18n", () => {
  it("supports exactly Korean and English, Korean first", () => {
    expect(LOCALES).toEqual(["ko", "en"]);
    expect(DEFAULT_LOCALE).toBe("ko");
    expect(isLocale("ko")).toBe(true);
    expect(isLocale("ja")).toBe(false);
  });

  it("translates and interpolates", () => {
    expect(t("en", "common.save")).toBe("Save");
    expect(t("ko", "common.save")).toBe("저장");
    expect(createT("en")("greeting.hello", { name: "Min" })).toBe("Hello, Min");
    expect(createT("ko")("greeting.hello", { name: "민" })).toBe("민님, 안녕하세요");
    expect(createT("en")("greeting.hello")).toBe("Hello, {name}");
  });

  it("formats number parameters for the locale", () => {
    expect(t("en", "status.latency", { ms: 1234 })).toBe("1,234 ms");
    expect(t("ko", "status.cursor", { line: 1200, col: 4 })).toBe("1,200줄 4열");
  });

  it("selects plural forms from params.count", () => {
    expect(t("en", "nearby.people", { count: 1 })).toBe("1 person here");
    expect(t("en", "nearby.people", { count: 3 })).toBe("3 people here");
    expect(t("en", "nearby.people", { count: 0 })).toBe("0 people here");
    expect(t("ko", "nearby.people", { count: 1 })).toBe("1명 참여 중");
    expect(t("ko", "nearby.people", { count: 3 })).toBe("3명 참여 중");
  });

  it("falls back to the .other form when no count is given", () => {
    expect(t("en", "nearby.people")).toBe("{count} people here");
    expect(t("ko", "nearby.people")).toBe("{count}명 참여 중");
  });

  it("returns the key for an unknown message instead of throwing", () => {
    expect(t("en", "does.not.exist" as never)).toBe("does.not.exist");
  });

  it("exposes both dictionaries", () => {
    expect(Object.keys(dictionaries.en).length).toBeGreaterThan(300);
    expect(Object.keys(dictionaries.ko).length).toBeGreaterThan(300);
  });
});
