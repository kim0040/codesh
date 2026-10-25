import { LANGUAGES } from "@gachipad/highlight";
import { defaultSettings } from "@gachipad/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, FONT_SIZE_MAX, FONT_SIZE_MIN, KEYMAPS, TAB_SIZES } from "../../lib/prefs";
import { GUIDE_PAGES, LEGACY_ANCHORS } from "../intro/nav";
import { EDITOR_FACTS, FACTS } from "./facts";

describe("guide facts", () => {
  it("match the editor preferences", () => {
    expect(EDITOR_FACTS.fontMin).toBe(FONT_SIZE_MIN);
    expect(EDITOR_FACTS.fontMax).toBe(FONT_SIZE_MAX);
    expect(EDITOR_FACTS.fontDefault).toBe(DEFAULT_PREFS.fontSize);
    expect([...EDITOR_FACTS.tabSizes]).toEqual([...TAB_SIZES]);
    expect([...EDITOR_FACTS.keymaps]).toEqual([...KEYMAPS]);
    expect(DEFAULT_PREFS.smoothTyping).toBe(true);
    expect(DEFAULT_PREFS.notifications).toBe(false);
  });

  it("match the default settings the text calls defaults", () => {
    const defaults = defaultSettings();
    expect(FACTS.defaultUploadMB).toBe(defaults.maxUploadMB);
    expect(FACTS.defaultDocMB * 1024 * 1024).toBe(defaults.maxDocBytes);
    expect(FACTS.defaultHistoryDays).toBe(defaults.historyRetentionDays);
    expect(defaults.audit.enabled).toBe(false);
    expect(defaults.audit.retentionDays).toBe(90);
  });

  it("back the claim of more than 200 languages", () => {
    expect(LANGUAGES.length).toBeGreaterThan(200);
  });
});

describe("guide pages", () => {
  it("send every old anchor to a page of the guide", () => {
    const targets = new Set<string>(GUIDE_PAGES.map((page) => page.to));
    for (const [anchor, to] of Object.entries(LEGACY_ANCHORS)) {
      expect(targets.has(to), anchor).toBe(true);
    }
  });

  it("keep every page under /guide with a unique slug", () => {
    expect(new Set(GUIDE_PAGES.map((page) => page.slug)).size).toBe(GUIDE_PAGES.length);
    for (const page of GUIDE_PAGES) expect(page.to).toBe(`/guide/${page.slug}`);
  });
});
