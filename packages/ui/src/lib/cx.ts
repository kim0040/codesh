export type ClassValue = string | false | null | undefined | 0;

/**
 * Joins class names, dropping falsy values. It does not merge conflicting utilities, so a caller's
 * `className` must not fight the component's own classes: `hidden sm:inline-flex` on an
 * `inline-flex` component never hides it. Use `max-sm:hidden` (a variant of its own) instead.
 */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
