import { createT, DEFAULT_LOCALE, isLocale, type Locale, type TFunction } from "@gachipad/i18n";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const STORAGE_KEY = "gachipad.locale";

/** Saved choice first, then the browser language (Korean or English), else Korean. */
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be blocked; fall through to the browser language.
  }
  const browser = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  if (browser.startsWith("ko")) return "ko";
  if (browser.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
}

const defaultValue: I18nValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: createT(DEFAULT_LOCALE),
};

const I18nContext = createContext<I18nValue>(defaultValue);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this page view.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: createT(locale) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

export function useLocale(): [Locale, (locale: Locale) => void] {
  const { locale, setLocale } = useContext(I18nContext);
  return [locale, setLocale];
}
