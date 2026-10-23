export type ClassValue = string | false | null | undefined | 0;

/** Joins class names, dropping falsy values. Variant classes never overlap, so no merge step is needed. */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
