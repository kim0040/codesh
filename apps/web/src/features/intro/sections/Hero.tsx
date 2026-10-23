import { lazy, Suspense, useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { SCENES } from "../demo-script";
import { StartSlot } from "../start-slot";
import { lang } from "../static-data";

// CodeMirror, the grammars and the highlight themes load as their own chunk, after first paint.
const DemoEditor = lazy(() => import("../DemoEditor"));

/** Same frame as the editor, so nothing moves when the real one arrives. */
function DemoSkeleton() {
  return (
    <div className="ix-ed" data-ui aria-hidden="true">
      <div className="ix-ed-top">
        <div className="ix-ed-tabs">
          {SCENES.map((scene, index) => (
            <span className="ix-ed-tab" data-on={index === 0 ? "" : undefined} key={scene.filename}>
              <span className="ix-dot" style={{ backgroundColor: lang(scene.languageId).color }} />
              {scene.filename}
            </span>
          ))}
        </div>
      </div>
      <div className="ix-ed-body" />
      <div className="ix-ed-status" />
    </div>
  );
}

function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const start = () => setReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(start, { timeout: 600 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = setTimeout(start, 80);
    return () => clearTimeout(handle);
  }, []);
  return ready;
}

export function Hero() {
  const t = useT();
  const ready = useAfterFirstPaint();
  return (
    <section className="ix-hero" aria-labelledby="ix-hero-title">
      <div className="ix-wrap">
        <h1 id="ix-hero-title" className="ix-h1">
          {t("intro.hero.title")}
        </h1>
        <p className="ix-lead ix-hero-lead">{t("intro.hero.sub")}</p>
        <div className="ix-hero-grid">
          <div className="ix-hero-start" id="start">
            <StartSlot />
          </div>
          <div className="ix-hero-demo">
            {ready ? (
              <Suspense fallback={<DemoSkeleton />}>
                <DemoEditor />
              </Suspense>
            ) : (
              <DemoSkeleton />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
