import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../shared/src/errors.js";
import { BUILTIN_TEMPLATES } from "../../shared/src/templates.js";
import { dictionaries, LOCALES, type Locale } from "./index.js";

const en: Readonly<Record<string, string>> = dictionaries.en as Record<string, string>;
const ko: Readonly<Record<string, string>> = dictionaries.ko as Record<string, string>;
const entries = (locale: Locale) => Object.entries(locale === "en" ? en : ko);

const NAMESPACES = new Set([
  "app",
  "common",
  "time",
  "nav",
  "locale",
  "greeting",
  "intro",
  "share",
  "editor",
  "approval",
  "settings",
  "status",
  "conn",
  "pin",
  "wait",
  "myshares",
  "nearby",
  "invite",
  "toast",
  "upload",
  "lab",
  "history",
  "diff",
  "comment",
  "admin",
  "identity",
  "palette",
  "template",
  "shortcuts",
  "empty",
  "a11y",
  "error",
  "tour",
]);

/** Korean values that are brand names, product names or units and legitimately have no Hangul. */
const LATIN_ONLY_KO = new Set([
  "app.name",
  "locale.en",
  "pin.label",
  "status.latency",
  "tour.step",
  "history.position",
  "invite.received.detail",
  "editor.files.namePlaceholder",
  "settings.editorTheme.slate",
  "settings.editorTheme.graphite",
  "settings.editorTheme.paper",
  "settings.editorTheme.sand",
  "settings.keymap.vim",
  "settings.keymap.emacs",
  "settings.keymap.sublime",
  "admin.unit.megabytes",
  "admin.setting.contact.placeholder",
]);

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const placeholders = (message: string) => message.match(/\{\w+\}/g)?.sort() ?? [];
const isPluralKey = (key: string) => /\.(one|other)$/.test(key);
const base = (key: string) => key.replace(/\.(one|other)$/, "");
const isButtonLabel = (key: string) =>
  /(^|\.)([a-z0-9]*Action|action)$/.test(key) || key.startsWith("common.");

describe("dictionary structure", () => {
  it("has the same keys in both languages; Korean may omit .one", () => {
    const koKeys = Object.keys(ko).sort();
    const enKeys = Object.keys(en)
      .filter((key) => !key.endsWith(".one"))
      .sort();
    expect(koKeys.filter((key) => !key.endsWith(".one"))).toEqual(enKeys);
    for (const key of koKeys.filter((key) => key.endsWith(".one"))) {
      expect(en[key], `${key} exists only in ko`).toBeDefined();
    }
  });

  it("gives every English plural family both .one and .other", () => {
    for (const key of Object.keys(en).filter(isPluralKey)) {
      const family = base(key);
      expect(en[`${family}.one`], `${family}.one`).toBeDefined();
      expect(en[`${family}.other`], `${family}.other`).toBeDefined();
    }
  });

  it("never mixes a plain key with a plural family of the same name", () => {
    for (const key of Object.keys(en).filter(isPluralKey)) {
      expect(en[base(key)], `${base(key)} has both a plain and a plural form`).toBeUndefined();
    }
  });

  it("keeps the same placeholders in both languages", () => {
    for (const [key, message] of Object.entries(ko)) {
      expect(placeholders(message), key).toEqual(placeholders(en[key] ?? ""));
    }
    for (const key of Object.keys(en).filter((key) => key.endsWith(".one"))) {
      expect(placeholders(en[key] ?? ""), key).toEqual(
        placeholders(en[`${base(key)}.other`] ?? ""),
      );
    }
  });

  it("puts every key under a known namespace", () => {
    for (const key of Object.keys(en)) {
      expect(NAMESPACES.has(key.split(".")[0] ?? ""), key).toBe(true);
    }
  });
});

describe("message hygiene", () => {
  for (const locale of LOCALES) {
    it(`${locale}: no empty, padded or doubly spaced messages`, () => {
      for (const [key, message] of entries(locale)) {
        expect(message, key).not.toBe("");
        expect(message, key).toBe(message.trim());
        expect(message, key).not.toMatch(/ {2}/);
      }
    });

    it(`${locale}: uses … and curly quotes, never ... or straight double quotes`, () => {
      for (const [key, message] of entries(locale)) {
        expect(message, key).not.toContain("...");
        expect(message, key).not.toContain('"');
      }
    });
  }

  it("en: contains no Hangul except the Korean language name", () => {
    for (const [key, message] of entries("en")) {
      if (key === "locale.ko") continue;
      expect(message, key).not.toMatch(HANGUL);
    }
  });

  it("ko: contains Hangul except for brand names, product names and units", () => {
    for (const [key, message] of entries("ko")) {
      if (LATIN_ONLY_KO.has(key)) continue;
      expect(message, key).toMatch(HANGUL);
    }
  });

  it("stays inside the product scope (no calls, chat, screen sharing or interview tooling)", () => {
    for (const [key, message] of entries("en")) {
      expect(message, key).not.toMatch(/\b(video|voice|chat|interview|webcam|microphone)\b/i);
      expect(message, key).not.toMatch(/screen shar/i);
    }
    for (const [key, message] of entries("ko")) {
      expect(message, key).not.toMatch(/화상|음성 통화|채팅|면접|화면 공유|코드 실행/);
    }
  });

  it("keeps button labels short enough for 320px layouts", () => {
    for (const [key, message] of entries("ko")) {
      if (isButtonLabel(key))
        expect([...message].length, `${key}: ${message}`).toBeLessThanOrEqual(14);
    }
    for (const [key, message] of entries("en")) {
      if (isButtonLabel(key))
        expect([...message].length, `${key}: ${message}`).toBeLessThanOrEqual(22);
    }
  });

  it("avoids sentence-final punctuation on buttons and ends sentences consistently", () => {
    for (const locale of LOCALES) {
      for (const [key, message] of entries(locale)) {
        if (isButtonLabel(key)) expect(message, key).not.toMatch(/[.!]$/);
        expect(message, key).not.toMatch(/!/);
      }
    }
  });
});

describe("error codes", () => {
  it("has a message and a hint for every code in packages/shared", () => {
    for (const code of ERROR_CODES) {
      for (const locale of LOCALES) {
        const dictionary = locale === "en" ? en : ko;
        expect(dictionary[`error.${code}`], `${locale} error.${code}`).toBeTruthy();
        expect(dictionary[`error.${code}.hint`], `${locale} error.${code}.hint`).toBeTruthy();
      }
    }
  });

  it("does not surface raw codes to people", () => {
    for (const [key, message] of [...entries("en"), ...entries("ko")]) {
      if (key.startsWith("error.")) expect(message, key).not.toContain("_");
    }
  });
});

describe("template texts", () => {
  it("has a name and a description in both languages for every built-in template", () => {
    for (const template of BUILTIN_TEMPLATES) {
      for (const locale of LOCALES) {
        const dictionary = locale === "en" ? en : ko;
        expect(dictionary[template.nameKey], `${locale} ${template.nameKey}`).toBeTruthy();
        expect(
          dictionary[template.descriptionKey],
          `${locale} ${template.descriptionKey}`,
        ).toBeTruthy();
      }
    }
  });

  it("names every language the same way in both languages", () => {
    for (const template of BUILTIN_TEMPLATES) {
      const first = (en[template.nameKey] ?? "").split(/[ ·]/)[0] ?? "";
      expect(ko[template.nameKey] ?? "", template.nameKey).toContain(first);
    }
  });
});
