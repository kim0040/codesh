import { LOCALES } from "@codesh/i18n";
import { useLocale, useT } from "../../../lib/i18n";

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

export function Header() {
  const t = useT();
  return (
    <header className="ix-header">
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
        <LocaleSwitch />
      </div>
    </header>
  );
}
