import { type ComponentType, useState } from "react";
import { useT } from "../../../lib/i18n";
import { BroadcastArt, CodeArt, NearbyArt, QrArt, SendArt } from "../art";
import { reveal } from "../reveal";

const WAYS = [
  { key: "code", Art: CodeArt },
  { key: "qr", Art: QrArt },
  { key: "nearby", Art: NearbyArt },
  { key: "send", Art: SendArt },
  { key: "broadcast", Art: BroadcastArt },
] as const satisfies readonly { key: string; Art: ComponentType }[];

/** Five ways in. Choosing a row (or pointing at it) changes the drawing in the one fixed frame. */
export function FastSection() {
  const t = useT();
  const [active, setActive] = useState(0);
  const Current = WAYS[active]?.Art ?? CodeArt;
  return (
    <section id="fast" className="ix-section ix-section-panel" aria-labelledby="ix-fast-title">
      <div className="ix-wrap ix-fast">
        <div className="ix-fast-copy">
          <h2 id="ix-fast-title" className="ix-h2" {...reveal()}>
            {t("intro.fast.title")}
          </h2>
          <p className="ix-lead" {...reveal(70)}>
            {t("intro.fast.sub")}
          </p>
          <ul className="ix-ways" {...reveal(140)}>
            {WAYS.map((way, index) => (
              <li className="ix-way" data-on={index === active ? "" : undefined} key={way.key}>
                <h3>
                  <button
                    type="button"
                    className="ix-way-btn"
                    aria-pressed={index === active}
                    onClick={() => setActive(index)}
                    onPointerEnter={(event) => {
                      if (event.pointerType === "mouse") setActive(index);
                    }}
                  >
                    {t(`intro.fast.${way.key}.title`)}
                  </button>
                </h3>
                <p className="ix-sr">{t(`intro.fast.${way.key}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="ix-stage" aria-hidden="true" {...reveal(120)}>
          <div className="ix-stage-art" key={active}>
            <div className="ix-stage-draw">
              <Current />
            </div>
            <p className="ix-stage-text">{t(`intro.fast.${WAYS[active]?.key ?? "code"}.body`)}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
