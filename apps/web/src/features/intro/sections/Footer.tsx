import { Link, useNavigate } from "@tanstack/react-router";
import { useT } from "../../../lib/i18n";
import { LICENSES_URL } from "../../../lib/licenses";
import { NameCells } from "../art";
import { ArrowRightIcon } from "../icons";
import { GUIDE_PAGES } from "../nav";
import { reveal } from "../reveal";
import { LocaleSwitch, ThemeSwitch } from "./Header";

export interface FooterProps {
  version: string;
  contact?: string;
}

export function Footer({ version, contact }: FooterProps) {
  const t = useT();
  const navigate = useNavigate();
  // The start panel lives on the home page; from a guide page the button leads there.
  const toStart = () => {
    const start = document.getElementById("start");
    if (!start) {
      void navigate({ to: "/" });
      return;
    }
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
          <div className="ix-footer-lead" {...reveal(60)}>
            <p className="ix-footer-tagline">{t("app.tagline")}</p>
            <div className="ix-footer-notes">
              <p>{t("intro.footer.noTracking")}</p>
              {contact ? <p>{t("intro.footer.contact", { contact })}</p> : null}
              <p>
                <a href={LICENSES_URL} target="_blank" rel="noopener noreferrer">
                  {t("intro.footer.licenses")}
                  <span className="ix-sr">{t("a11y.opensInNewTab")}</span>
                </a>
              </p>
            </div>
          </div>
          <nav className="ix-footer-links" aria-label={t("intro.footer.navLabel")}>
            {GUIDE_PAGES.map(({ to, navKey }) => (
              <Link key={to} to={to}>
                {t(navKey)}
              </Link>
            ))}
          </nav>
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
