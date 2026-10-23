import { type DictionaryKey, en, type MessageKey } from "./en.js";
import { ko } from "./ko.js";

export type { DictionaryKey, MessageKey } from "./en.js";
export type { KoDictionary } from "./ko.js";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export const dictionaries: Record<Locale, Readonly<Partial<Record<DictionaryKey, string>>>> = {
  ko,
  en,
};

export type MessageParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: MessageParams) => string;

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function rulesFor(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

/** Locale-aware number formatting (`1,234` / `1,234`); shared by `t()` and the helpers. */
export function formatNumber(locale: Locale, value: number): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale);
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

/** Replaces `{name}` placeholders; numbers are formatted for the locale, unknown placeholders stay as written. */
function interpolate(locale: Locale, message: string, params?: MessageParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number" ? formatNumber(locale, value) : value;
  });
}

function lookup(locale: Locale, key: MessageKey, params?: MessageParams): string | undefined {
  const dictionary = dictionaries[locale] as Readonly<Record<string, string | undefined>>;
  const count = params?.count;
  if (typeof count === "number") {
    const category = rulesFor(locale).select(count);
    return dictionary[`${key}.${category}`] ?? dictionary[`${key}.other`] ?? dictionary[key];
  }
  return dictionary[key] ?? dictionary[`${key}.other`];
}

/**
 * React-free translation helper.
 *
 * Plural families (`foo.one` / `foo.other`) are chosen by `params.count` with `Intl.PluralRules`.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return interpolate(locale, lookup(locale, key, params) ?? key, params);
}

export function createT(locale: Locale): TFunction {
  return (key, params) => t(locale, key, params);
}
