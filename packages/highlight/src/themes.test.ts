import { tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { type ColorVision, contrastRatio, deltaE, mix, simulateColorVision } from "./color.js";
import { TOKEN_NAMES } from "./theme-colors.js";
import { EDITOR_THEMES, getEditorTheme, isThemeId } from "./themes.js";

const HEX = /^#[0-9a-f]{6}$/;
const VISIONS: ColorVision[] = ["protanopia", "deuteranopia", "tritanopia"];

describe("editor themes", () => {
  it("ships two dark and two light themes with stable ids", () => {
    expect(EDITOR_THEMES.map((theme) => theme.id)).toEqual(["slate", "graphite", "paper", "sand"]);
    expect(EDITOR_THEMES.filter((theme) => theme.appearance === "dark")).toHaveLength(2);
    expect(EDITOR_THEMES.filter((theme) => theme.appearance === "light")).toHaveLength(2);
    expect(getEditorTheme("sand").appearance).toBe("light");
    expect(isThemeId("slate")).toBe(true);
    expect(isThemeId("solarized")).toBe(false);
    expect(() => getEditorTheme("nope" as never)).toThrow();
  });

  it("defines every required token as a plain #rrggbb colour", () => {
    expect(TOKEN_NAMES).toEqual([
      "keyword",
      "string",
      "comment",
      "number",
      "type",
      "function",
      "variable",
      "property",
      "operator",
      "tag",
      "attribute",
      "regexp",
      "invalid",
    ]);
    for (const theme of EDITOR_THEMES) {
      expect(theme.background).toMatch(HEX);
      expect(theme.foreground).toMatch(HEX);
      expect(theme.selection).toMatch(HEX);
      for (const name of TOKEN_NAMES)
        expect(theme.tokens[name], `${theme.id}.${name}`).toMatch(HEX);
      // The caret-line overlay is the one translucent colour (#rrggbbaa).
      const { activeLineOverlay: _overlay, ...opaque } = theme.surfaces;
      for (const value of Object.values(opaque)) expect(value).toMatch(HEX);
    }
  });

  describe.each(EDITOR_THEMES.map((theme) => [theme.id, theme] as const))("%s", (_id, theme) => {
    it("keeps the foreground and every token at 4.5:1 or more on the background", () => {
      const failures: string[] = [];
      const check = (name: string, colour: string) => {
        const ratio = contrastRatio(colour, theme.background);
        if (ratio < 4.5)
          failures.push(`${name} ${colour} on ${theme.background} = ${ratio.toFixed(2)}`);
      };
      check("foreground", theme.foreground);
      check("punctuation", theme.surfaces.punctuation);
      check("gutter", theme.surfaces.gutter);
      for (const name of TOKEN_NAMES) check(name, theme.tokens[name]);
      expect(failures).toEqual([]);
    });

    it("keeps text readable on selection, highlights and panels", () => {
      const { surfaces, tokens, foreground } = theme;
      const textSurfaces = {
        selection: surfaces.selection,
        activeLine: surfaces.activeLine,
        selectionMatch: surfaces.selectionMatch,
        searchMatch: surfaces.searchMatch,
        searchMatchSelected: surfaces.searchMatchSelected,
        matchingBracket: surfaces.matchingBracket,
        panel: surfaces.panel,
      };
      for (const [name, surface] of Object.entries(textSurfaces)) {
        expect(contrastRatio(foreground, surface), `foreground on ${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      // The line under the caret and tooltips hold full syntax colour, so they get the full bar.
      for (const surface of [surfaces.activeLine, surfaces.panel]) {
        for (const name of TOKEN_NAMES) {
          expect(
            contrastRatio(tokens[name], surface),
            `${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      // Selected code stays legible: 3:1 for coloured tokens, 4.5:1 for plain text (above).
      for (const surface of [
        surfaces.selection,
        surfaces.selectionMatch,
        surfaces.matchingBracket,
      ]) {
        for (const name of TOKEN_NAMES) {
          expect(
            contrastRatio(tokens[name], surface),
            `${name} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      expect(contrastRatio(surfaces.gutter, surfaces.activeLine)).toBeGreaterThanOrEqual(4.5);
    });

    it("lets selections show through the caret's line", () => {
      const { surfaces, background } = theme;
      // Remote selections sit in a layer behind the text: an opaque line background covers them.
      expect(surfaces.activeLineOverlay).toMatch(/^#[0-9a-f]{8}$/i);
      const alpha = Number.parseInt(surfaces.activeLineOverlay.slice(-2), 16) / 255;
      expect(alpha).toBeLessThan(0.2);
      const overlay = surfaces.activeLineOverlay.slice(0, 7);
      expect(deltaE(mix(overlay, background, alpha), surfaces.activeLine)).toBeLessThan(0.01);
    });

    it("keeps every colour of the theme visibly different from the others", () => {
      const colours = { foreground: theme.foreground, ...theme.tokens };
      const names = Object.keys(colours) as (keyof typeof colours)[];
      const tooClose: string[] = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = names[i] as keyof typeof colours;
          const b = names[j] as keyof typeof colours;
          const distance = deltaE(colours[a], colours[b]);
          if (distance < 0.04) tooClose.push(`${a}~${b}=${distance.toFixed(3)}`);
        }
      }
      expect(tooClose).toEqual([]);
    });

    it.each(VISIONS)("keeps keyword, string and comment apart under %s", (vision) => {
      const trio = (["keyword", "string", "comment"] as const).map((name) =>
        simulateColorVision(theme.tokens[name], vision),
      ) as [string, string, string];
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        expect(deltaE(trio[a], trio[b])).toBeGreaterThanOrEqual(0.05);
      }
    });

    it("styles comments italic and keywords at weight 500, with a wavy underline for invalid", () => {
      const specs = theme.highlightStyle.specs;
      const has = (tag: unknown) =>
        specs.find((spec) =>
          (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).includes(tag as never),
        );
      expect(has(t.comment)?.fontStyle).toBe("italic");
      expect(has(t.lineComment)?.fontStyle).toBe("italic");
      expect(has(t.keyword)?.fontWeight).toBe("500");
      expect(has(t.controlKeyword)?.fontWeight).toBe("500");
      expect(has(t.invalid)?.textDecoration).toContain("wavy");
      expect(has(t.keyword)?.color).toBe(theme.tokens.keyword);
      expect(has(t.string)?.color).toBe(theme.tokens.string);
      expect(has(t.comment)?.color).toBe(theme.tokens.comment);
      expect(has(t.regexp)?.color).toBe(theme.tokens.regexp);
      expect(has(t.tagName)?.color).toBe(theme.tokens.tag);
      expect(has(t.attributeName)?.color).toBe(theme.tokens.attribute);
      expect(has(t.typeName)?.color).toBe(theme.tokens.type);
      expect(has(t.function(t.variableName))?.color).toBe(theme.tokens.function);
      expect(has(t.propertyName)?.color).toBe(theme.tokens.property);
      expect(has(t.number)?.color).toBe(theme.tokens.number);
      expect(has(t.operator)?.color).toBe(theme.tokens.operator);
      expect(has(t.variableName)?.color).toBe(theme.tokens.variable);
      expect(has(t.invalid)?.color).toBe(theme.tokens.invalid);
    });

    it("exposes a CodeMirror extension", () => {
      expect(theme.extension).toBeDefined();
    });
  });
});
