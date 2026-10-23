import { describe, expect, it } from "vitest";
import { createT, DEFAULT_LOCALE, dictionaries, isLocale, LOCALES, t } from "./index.js";

describe("i18n", () => {
  it("supports exactly Korean and English, Korean first", () => {
    expect(LOCALES).toEqual(["ko", "en"]);
    expect(DEFAULT_LOCALE).toBe("ko");
    expect(isLocale("ko")).toBe(true);
    expect(isLocale("ja")).toBe(false);
  });

  it("has identical keys in both dictionaries and no empty messages", () => {
    expect(Object.keys(dictionaries.ko).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const locale of LOCALES) {
      for (const message of Object.values(dictionaries[locale])) expect(message).not.toBe("");
    }
  });

  it("translates and interpolates", () => {
    expect(t("en", "common.save")).toBe("Save");
    expect(t("ko", "common.save")).toBe("저장");
    expect(createT("en")("greeting.hello", { name: "Min" })).toBe("Hello, Min");
    expect(createT("ko")("greeting.hello", { name: "민" })).toBe("민님, 안녕하세요");
    expect(createT("en")("greeting.hello")).toBe("Hello, {name}");
  });

  it("keeps the same placeholders in both languages", () => {
    const placeholders = (message: string) => message.match(/\{\w+\}/g)?.sort() ?? [];
    for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      expect(placeholders(dictionaries.ko[key])).toEqual(placeholders(dictionaries.en[key]));
    }
  });
});
