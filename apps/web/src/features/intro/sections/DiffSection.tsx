import { useT } from "../../../lib/i18n";
import { reveal } from "../reveal";

const CLAIMS = [
  { key: "noAds", span: 1 },
  { key: "free", span: 1 },
  { key: "offline", span: 2 },
  { key: "erased", span: 2 },
] as const;

export function DiffSection() {
  const t = useT();
  return (
    <section id="different" className="ix-section ix-section-panel" aria-labelledby="ix-diff-title">
      <div className="ix-wrap">
        <div className="ix-diff">
          <div className="ix-diff-head" {...reveal()}>
            <h2 id="ix-diff-title" className="ix-h2 ix-diff-title">
              {t("intro.diff.title")}
            </h2>
          </div>
          {CLAIMS.map(({ key, span }, index) => (
            <div className="ix-claim" data-span={span} key={key} {...reveal((index % 3) * 80)}>
              <h3 className="ix-claim-title">{t(`intro.diff.${key}`)}</h3>
              <p>{t(`intro.diff.${key}Body`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
