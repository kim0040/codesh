/**
 * Initials for an avatar. Hangul and other CJK names use the first syllable ("김현민" → "김");
 * Latin names use up to two word initials ("Ada Lovelace" → "AL"). Emoji and symbols are kept whole.
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const graphemes = (text: string) =>
    Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  if (/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(trimmed)) {
    return graphemes(trimmed)[0] ?? "?";
  }
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => graphemes(word)[0] ?? "");
  return initials.join("").toUpperCase() || "?";
}
