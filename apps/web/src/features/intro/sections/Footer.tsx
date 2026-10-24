import { useT } from "../../../lib/i18n";
import { NameCells } from "../art";
import { ArrowRightIcon } from "../icons";
import { reveal } from "../reveal";
import { LocaleSwitch, ThemeSwitch } from "./Header";

export interface FooterProps {
  version: string;
  contact?: string;
}

export function Footer({ version, contact }: FooterProps) {
  const t = useT();
  const toStart = () => {
    const start = document.getElementById("start");
    if (!start) return;
    start.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    start
      .querySelector<HTMLElement>("button, a[href], input, [tabindex]")
      ?.focus({ preventScroll: true });
  };
  return (
    <footer className="ix-footer">
      <div className="ix-wrap">
        <div {...reveal()}>
          <NameCells />
        </div>
        <p className="ix-sr">{t("app.name")}</p>
        <div className="ix-footer-grid">
          <nav className="ix-footer-links" aria-label={t("a11y.mainNavigation")}>
            <a href="#how">{t("intro.nav.how")}</a>
            <a href="#features">{t("intro.nav.features")}</a>
            <a href="#faq">{t("intro.nav.faq")}</a>
          </nav>
          <div className="ix-footer-notes">
            <p>{t("intro.footer.noTracking")}</p>
            {contact ? <p>{t("intro.footer.contact", { contact })}</p> : null}
          </div>
        </div>
        <div className="ix-footer-bar">
          <p className="ix-footer-version">{t("intro.footer.version", { version })}</p>
          <div className="ix-footer-controls">
            <LocaleSwitch />
            <ThemeSwitch />
          </div>
          <button type="button" className="ix-btn ix-btn-primary ix-btn-sm" onClick={toStart}>
            {t("intro.hero.startAction")}
            <ArrowRightIcon />
          </button>
        </div>
      </div>
    </footer>
  );
}
