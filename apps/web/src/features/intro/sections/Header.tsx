import { LOCALES } from "@codesh/i18n";
import { useLocale, useT } from "../../../lib/i18n";
import { useHidingHeader } from "../hooks";
import { MonitorIcon, MoonIcon, SunIcon } from "../icons";
import { applyThemePreference, type ThemePreference, useThemePreference } from "../theme-switch";

export function LocaleSwitch() {
  const t = useT();
  const [locale, setLocale] = useLocale();
  return (
    <fieldset className="ix-seg-control">
      <legend className="ix-sr">{t("a11y.switchLanguage")}</legend>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={locale === code}
          onClick={() => setLocale(code)}
        >
          {t(code === "ko" ? "locale.ko" : "locale.en")}
        </button>
      ))}
    </fieldset>
  );
}

const THEMES = [
  ["system", "settings.uiTheme.system", MonitorIcon],
  ["light", "settings.uiTheme.light", SunIcon],
  ["dark", "settings.uiTheme.dark", MoonIcon],
] as const satisfies readonly (readonly [ThemePreference, string, unknown])[];

/** System / light / dark. Text buttons by default, icon-only where room is tight (the header). */
export function ThemeSwitch({ icons = false }: { icons?: boolean }) {
  const t = useT();
  const preference = useThemePreference();
  return (
    <fieldset className={icons ? "ix-seg-control ix-seg-icons" : "ix-seg-control"}>
      <legend className="ix-sr">{t("a11y.switchTheme")}</legend>
      {THEMES.map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          aria-label={icons ? t(label) : undefined}
          title={icons ? t(label) : undefined}
          onClick={() => applyThemePreference(value)}
        >
          {icons ? <Icon /> : t(label)}
        </button>
      ))}
    </fieldset>
  );
}

export function Header() {
  const t = useT();
  const ref = useHidingHeader<HTMLElement>();
  return (
    <header className="ix-header" ref={ref}>
      <div className="ix-wrap ix-header-row">
        <a className="ix-brand" href="/">
          {t("app.name")}
        </a>
        <nav className="ix-nav" aria-label={t("a11y.mainNavigation")}>
          <a href="#how" className="ix-nav-how">
            {t("intro.nav.how")}
          </a>
          <a href="#features">{t("intro.nav.features")}</a>
          <a href="#faq">{t("intro.nav.faq")}</a>
        </nav>
        <div className="ix-header-controls">
          <LocaleSwitch />
          <ThemeSwitch icons />
        </div>
      </div>
    </header>
  );
}
