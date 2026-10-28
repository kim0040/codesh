/** Small sRGB/OKLab toolkit used by the contrast tests and by the colour tooling. Hex in, numbers out. */

export type Rgb = readonly [r: number, g: number, b: number];
export type Oklab = readonly [L: number, a: number, b: number];

const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgb(hex: string): Rgb {
  const match = HEX.exec(hex);
  if (!match?.[1]) throw new Error(`expected #rrggbb, got "${hex}"`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (c: number): number =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Alpha-composites `fg` at `alpha` over `bg`. */
export function mix(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex([
    f[0] * alpha + b[0] * (1 - alpha),
    f[1] * alpha + b[1] * (1 - alpha),
    f[2] * alpha + b[2] * (1 - alpha),
  ]);
}

/** `#rrggbb` at `alpha` as `#rrggbbaa`; drawn over `bg` it looks like `mix(hex, bg, alpha)`. */
export function withAlpha(hex: string, alpha: number): string {
  hexToRgb(hex);
  const part = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${part}`;
}

export function hexToOklab(hex: string): Oklab {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab; ≈0.02 is a just-noticeable difference, ≥0.08 reads as clearly different. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = hexToOklab(a);
  const [l2, a2, b2] = hexToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function oklchToLinear(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH → #rrggbb; out-of-gamut colours lose chroma (not lightness or hue) until they fit. */
export function oklchToHex(L: number, C: number, hue: number): string {
  let chroma = C;
  for (let i = 0; i < 40; i++) {
    const lin = oklchToLinear(L, chroma, hue);
    if (lin.every((c) => c >= -0.0005 && c <= 1.0005)) {
      return rgbToHex([
        fromLinear(Math.min(1, Math.max(0, lin[0]))),
        fromLinear(Math.min(1, Math.max(0, lin[1]))),
        fromLinear(Math.min(1, Math.max(0, lin[2]))),
      ]);
    }
    chroma *= 0.96;
  }
  const gray = fromLinear(L ** 3);
  return rgbToHex([gray, gray, gray]);
}

export type ColorVision = "protanopia" | "deuteranopia" | "tritanopia";

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear sRGB.
const COLOR_VISION_MATRICES: Readonly<Record<ColorVision, readonly [Rgb, Rgb, Rgb]>> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** Approximates how `hex` looks to someone with the given dichromacy. */
export function simulateColorVision(hex: string, vision: ColorVision): string {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  const [row0, row1, row2] = COLOR_VISION_MATRICES[vision];
  const apply = (row: Rgb) =>
    fromLinear(Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)));
  return rgbToHex([apply(row0), apply(row1), apply(row2)]);
}
