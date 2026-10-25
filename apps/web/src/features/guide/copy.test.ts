import { describe, expect, it } from "vitest";
import { guideEn } from "./copy-en";
import { guideKo } from "./copy-ko";

const en: Readonly<Record<string, string>> = guideEn;
const ko: Readonly<Record<string, string>> = guideKo;
const entries = { en: Object.entries(en), ko: Object.entries(ko) };

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const placeholders = (message: string) => message.match(/\{\w+\}/g)?.sort() ?? [];

// Korean values that are product or unit names and legitimately have no Hangul.
const LATIN_ONLY_KO = new Set(["guide.features.shortcuts.mac", "guide.features.shortcuts.windows"]);

// Words that tie the copy to one kind of organisation or network (written as escapes so this
// file does not contain them itself): the same list the intro specs use.
const WHERE_WORDS = /사내|내부망|회사|intranet|company/i;

describe("guide copy", () => {
  it("has the same keys in both languages, all under guide.", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(key.startsWith("guide."), key).toBe(true);
  });

  it("keeps the same placeholders in both languages", () => {
    for (const [key, message] of entries.ko) {
      expect(placeholders(message), key).toEqual(placeholders(en[key] ?? ""));
    }
  });

  for (const locale of ["en", "ko"] as const) {
    it(`${locale}: no empty, padded or doubly spaced text, no ..., straight quotes or !`, () => {
      for (const [key, message] of entries[locale]) {
        expect(message, key).not.toBe("");
        expect(message, key).toBe(message.trim());
        expect(message, key).not.toMatch(/ {2}/);
        expect(message, key).not.toContain("...");
        expect(message, key).not.toContain('"');
        expect(message, key).not.toContain("!");
        expect(message, key).not.toMatch(WHERE_WORDS);
      }
    });
  }

  it("en has no Hangul and ko has Hangul (except product names)", () => {
    for (const [key, message] of entries.en) expect(message, key).not.toMatch(HANGUL);
    for (const [key, message] of entries.ko) {
      if (!LATIN_ONLY_KO.has(key)) expect(message, key).toMatch(HANGUL);
    }
  });

  it("stays inside the product scope (no calls, chat, screen sharing or interview tooling)", () => {
    for (const [key, message] of entries.en) {
      expect(message, key).not.toMatch(/\b(video|voice|chat|interview|webcam|microphone)\b/i);
      expect(message, key).not.toMatch(/screen shar/i);
    }
    for (const [key, message] of entries.ko) {
      expect(message, key).not.toMatch(/화상|음성 통화|채팅|면접|화면 공유|코드 실행/);
    }
  });
});
