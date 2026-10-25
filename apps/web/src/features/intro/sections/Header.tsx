import { LOCALES } from "@gachipad/i18n";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useLocale, useT } from "../../../lib/i18n";
import { useHidingHeader, useMatchMedia } from "../hooks";
import { CloseIcon, MenuIcon, MonitorIcon, MoonIcon, SunIcon } from "../icons";
import { GUIDE_PAGES } from "../nav";
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

/** At this width the links, both switches and the brand share one row; below it they move into a menu. */
const INLINE_NAV_QUERY = "(min-width: 960px)";

export function Header() {
  const t = useT();
  const ref = useHidingHeader<HTMLElement>();
  const inline = useMatchMedia(INLINE_NAV_QUERY);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The menu is open for the page it was opened on, so going to another page closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpenOn(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, ref]);

  return (
    <header className="ix-header" ref={ref} data-menu={open ? "" : undefined}>
      <div className="ix-wrap ix-header-row">
        <Link className="ix-brand" to="/">
          {t("app.name")}
        </Link>
        <button
          type="button"
          ref={button}
          className="ix-menu-btn"
          aria-expanded={open}
          aria-controls="ix-menu"
          onClick={() => setOpenOn(open ? null : pathname)}
        >
          {t("intro.nav.menuAction")}
          {open ? <CloseIcon /> : <MenuIcon />}
        </button>
        <div className="ix-menu" id="ix-menu">
          <nav className="ix-nav" aria-label={t("a11y.mainNavigation")}>
            {GUIDE_PAGES.map(({ to, navKey }) => (
              <Link key={to} to={to} onClick={() => setOpenOn(null)}>
                {t(navKey)}
              </Link>
            ))}
          </nav>
          <div className="ix-header-controls">
            <LocaleSwitch />
            <ThemeSwitch icons={inline} />
          </div>
        </div>
      </div>
    </header>
  );
}
