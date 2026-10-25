import { EDITOR_THEMES, getEditorTheme, getLanguage } from "@gachipad/highlight";
import { describe, expect, it } from "vitest";
import { EDITOR_COLORS, LANGS } from "./static-data.js";

describe("static data mirrors @gachipad/highlight", () => {
  it("uses the registry's names and colours for language chips", () => {
    for (const chip of LANGS) {
      const entry = getLanguage(chip.id);
      expect(entry, chip.id).toBeDefined();
      expect(chip.name, chip.id).toBe(entry?.name);
      expect(chip.color.toLowerCase(), chip.id).toBe(entry?.color.toLowerCase());
    }
  });

  it("uses slate in dark mode and paper in light mode", () => {
    expect(EDITOR_THEMES.length).toBeGreaterThan(0);
    const slate = getEditorTheme("slate");
    const paper = getEditorTheme("paper");
    for (const [name, dark, light] of EDITOR_COLORS) {
      if (name === "bg") {
        expect(dark).toBe(slate.background);
        expect(light).toBe(paper.background);
      } else if (name === "fg") {
        expect(dark).toBe(slate.foreground);
        expect(light).toBe(paper.foreground);
      } else {
        expect(dark, name).toBe(slate.tokens[name]);
        expect(light, name).toBe(paper.tokens[name]);
      }
    }
  });
});
