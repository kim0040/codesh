import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { usePrefersReducedMotion, useScrollReveal } from "./hooks";
import "./intro.css";
import { DiffSection } from "./sections/DiffSection";
import { FaqSection } from "./sections/FaqSection";
import { FastSection } from "./sections/FastSection";
import { FeaturesSection } from "./sections/FeaturesSection";
import { Footer } from "./sections/Footer";
import { Header } from "./sections/Header";
import { Hero } from "./sections/Hero";
import { HowSection } from "./sections/HowSection";
import { editorVars } from "./static-data";
import { buildVersion } from "./version";

/** Values the admin controls; the route passes them in once the settings endpoint exists. */
export interface IntroSettings {
  /** Shown in the footer when set. */
  contact?: string;
  /** How long an unsaved share lives. */
  anonymousTtlHours?: number;
}

export interface IntroPageProps {
  settings?: IntroSettings;
  version?: string;
}

const DEFAULT_TTL_HOURS = 24;

export function IntroPage({ settings, version = buildVersion() }: IntroPageProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  useScrollReveal(root, reduced);

  useEffect(() => {
    document.title = `${t("app.name")} – ${t("app.tagline")}`;
  }, [t]);

  return (
    <div className="ix" ref={root} style={editorVars}>
      <a className="ix-skip" href="#main">
        {t("a11y.skipToContent")}
      </a>
      <Header />
      <main id="main">
        <Hero />
        <HowSection />
        <FastSection />
        <FeaturesSection />
        <DiffSection />
        <FaqSection expiryHours={settings?.anonymousTtlHours ?? DEFAULT_TTL_HOURS} />
      </main>
      <Footer version={version} contact={settings?.contact} />
    </div>
  );
}
