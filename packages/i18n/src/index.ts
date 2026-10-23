import { en, type MessageKey } from "./en.js";
import { ko } from "./ko.js";

export type { MessageKey } from "./en.js";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export const dictionaries: Record<Locale, Record<MessageKey, string>> = { ko, en };

export type MessageParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: MessageParams) => string;

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

/** Replaces `{name}` placeholders; unknown placeholders are left as written. */
function interpolate(message: string, params?: MessageParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** React-free translation helper. */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return interpolate(dictionaries[locale][key], params);
}

export function createT(locale: Locale): TFunction {
  return (key, params) => t(locale, key, params);
}
