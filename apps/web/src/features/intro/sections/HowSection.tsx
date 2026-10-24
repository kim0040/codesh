import { useT } from "../../../lib/i18n";
import { reveal } from "../reveal";
import { SectionHead } from "./SectionHead";

const STEPS = [1, 2, 3] as const;

/** One bar, three stages: how long each takes sets how wide it is. */
export function HowSection() {
  const t = useT();
  return (
    <section id="how" className="ix-section" aria-labelledby="ix-how-title">
      <div className="ix-wrap">
        <SectionHead id="ix-how-title" title={t("intro.how.title")} sub={t("intro.how.sub")} />
        <ol className="ix-bar">
          {STEPS.map((step) => (
            <li className="ix-stage-seg" data-step={step} key={step} {...reveal(step * 90)}>
              <span className="ix-seg-time">{t(`intro.how.step${step}.time`)}</span>
              <div className="ix-seg-text">
                <h3 className="ix-seg-title">{t(`intro.how.step${step}.title`)}</h3>
                <p>{t(`intro.how.step${step}.body`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
