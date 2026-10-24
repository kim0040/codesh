import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, mix, PARTICIPANT_COLORS } from "@codesh/highlight";
import { describe, expect, it } from "vitest";

const styles = (file: string) => readFileSync(join(import.meta.dirname, "styles", file), "utf8");
const tokensCss = styles("tokens.css");
const themeCss = styles("theme.css");

/** `--name: value;` declarations from the top-level `:root` blocks (values may span lines). */
function declarations(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^:root \{([\s\S]*?)^\}/gm)) {
    for (const match of (block[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      map.set(match[1] as string, (match[2] as string).replace(/\s+/g, " ").trim());
    }
  }
  return map;
}

const tokens = declarations(tokensCss);

type Mode = "light" | "dark";
const MODES: Mode[] = ["light", "dark"];

/** Resolves `light-dark(a, b)` (or a plain colour) for one mode. */
function resolve(name: string, mode: Mode): string {
  const raw = tokens.get(`--${name}`);
  if (!raw) throw new Error(`missing token --${name}`);
  const match = /^light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)$/i.exec(raw);
  if (match) return (mode === "light" ? match[1] : match[2]) as string;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  throw new Error(`--${name} is not a plain colour: ${raw}`);
}

const SURFACES = ["bg", "panel", "raised", "overlay"] as const;
const STATUSES = ["accent", "success", "warning", "danger", "info"] as const;

const ratio = (fg: string, bg: string, mode: Mode) =>
  contrastRatio(resolve(fg, mode), resolve(bg, mode));

describe("colour tokens", () => {
  it.each(MODES)("text levels hold 4.5:1 on every surface (%s)", (mode) => {
    for (const fg of ["fg", "fg-2", "fg-3"]) {
      for (const bg of SURFACES)
        expect(ratio(fg, bg, mode), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Hover, selected and active rows are `fg` at 6, 8 and 10% over the surface (`--fill-*`).
  const FILLS = { "fill-hover": 0.06, "fill-selected": 0.08, "fill-active": 0.1 } as const;

  it.each(MODES)("fg and fg-2 hold 4.5:1 on every fill over every surface (%s)", (mode) => {
    for (const [fill, alpha] of Object.entries(FILLS)) {
      for (const bg of SURFACES) {
        const surface = mix(resolve("fg", mode), resolve(bg, mode), alpha);
        for (const fg of ["fg", "fg-2"]) {
          expect(
            contrastRatio(resolve(fg, mode), surface),
            `${fg} on ${fill} over ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it.each(MODES)("fg-3 holds 4.5:1 on the hover fill over every surface (%s)", (mode) => {
    // The selected and active fills are darker still; text on those uses fg-2 (see TemplatePicker).
    for (const bg of SURFACES) {
      const surface = mix(resolve("fg", mode), resolve(bg, mode), FILLS["fill-hover"]);
      expect(
        contrastRatio(resolve("fg-3", mode), surface),
        `fg-3 over ${bg}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MODES)("accent and status text hold 4.5:1 on surfaces and on their tint (%s)", (mode) => {
    for (const status of STATUSES) {
      for (const bg of SURFACES) {
        expect(ratio(`${status}-text`, bg, mode), `${status}-text on ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      expect(
        ratio(`${status}-text`, `${status}-soft`, mode),
        `${status}-text on soft`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio("fg", "accent-soft", mode)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MODES)("labels on filled actions hold 4.5:1 in rest, hover and active (%s)", (mode) => {
    for (const status of STATUSES) {
      for (const state of ["", "-hover", "-active"]) {
        expect(
          ratio(`${status}-fg`, `${status}${state}`, mode),
          `${status}${state}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(MODES)("control borders and the focus ring hold 3:1 on every surface (%s)", (mode) => {
    for (const fg of ["border-control", "focus"]) {
      for (const bg of SURFACES)
        expect(ratio(fg, bg, mode), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("defines every colour token for both themes", () => {
    for (const [name, value] of tokens) {
      if (/^--(rad|elev|easing|duration|space|z|font|edge|fill|scrim)/.test(name)) continue;
      expect(value, name).toMatch(/^(light-dark\(#[0-9a-f]{6}, ?#[0-9a-f]{6}\)|#[0-9a-f]{6})$/i);
    }
  });
});

describe("participant palette", () => {
  it("mirrors @codesh/highlight, slot by slot", () => {
    expect(PARTICIPANT_COLORS).toHaveLength(12);
    PARTICIPANT_COLORS.forEach((color, index) => {
      expect(tokens.get(`--participant-${index + 1}`)).toBe(color.hex);
      expect(tokens.get(`--participant-${index + 1}-fg`)).toBe(color.label);
    });
  });
});

describe("theme and structure", () => {
  it("maps every semantic colour into the Tailwind theme", () => {
    const mapped = new Set(
      [...themeCss.matchAll(/--color-([\w-]+): var\(--([\w-]+)\)/g)].map((m) => m[2]),
    );
    const names = [...tokens.keys()]
      .map((n) => n.slice(2))
      .filter((n) => !/^(rad|elev|easing|duration|space|z|font|edge|fill)(-|$)/.test(n));
    for (const name of names) {
      if (name.endsWith("-fg") && name.startsWith("participant")) continue;
      expect(mapped.has(name), `--${name} is not mapped in theme.css`).toBe(true);
    }
    for (const name of ["fill-hover", "fill-active", "fill-selected"])
      expect(mapped.has(name)).toBe(true);
  });

  it("collapses every duration under prefers-reduced-motion", () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(tokensCss)?.[1] ?? "";
    for (const name of tokens.keys()) {
      if (name.startsWith("--duration-")) expect(reduced, name).toContain(`${name}: 0.01ms`);
    }
  });

  it("orders the z-index scale", () => {
    const z = [...tokens].filter(([n]) => n.startsWith("--z-")).map(([, v]) => Number(v));
    expect(z.length).toBeGreaterThanOrEqual(6);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
    expect(new Set(z).size).toBe(z.length);
  });

  it("does not use external URLs", () => {
    for (const file of [
      "tokens.css",
      "theme.css",
      "fonts.css",
      "base.css",
      "motion.css",
      "index.css",
    ]) {
      expect(styles(file), file).not.toMatch(/https?:\/\//);
    }
  });
});
