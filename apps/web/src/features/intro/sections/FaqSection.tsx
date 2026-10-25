import { useId, useState } from "react";
import { useT } from "../../../lib/i18n";
import { reveal } from "../reveal";
import { FaqItem } from "./FaqItem";
import { MoreLink } from "./MoreLink";

/** The home page shows the first few; the rest are on the FAQ page. */
const FAQ = ["expiry", "save", "security"] as const;

export function FaqSection({ expiryHours }: { expiryHours: number }) {
  const t = useT();
  const base = useId();
  const [open, setOpen] = useState<(typeof FAQ)[number] | null>("expiry");
  return (
    <section className="ix-section" aria-labelledby="ix-faq-title">
      <div className="ix-wrap ix-faq">
        <div className="ix-faq-head">
          <h2 id="ix-faq-title" className="ix-h2 ix-faq-title" {...reveal()}>
            {t("intro.faq.title")}
          </h2>
          <div {...reveal(70)}>
            <MoreLink page="faq" faq />
          </div>
        </div>
        <ul className="ix-faq-list">
          {FAQ.map((key, index) => (
            <FaqItem
              id={`${base}-${key}`}
              key={key}
              question={t(`intro.faq.${key}.q`)}
              open={open === key}
              onToggle={() => setOpen(open === key ? null : key)}
              delay={index * 50}
            >
              <p>
                {key === "expiry"
                  ? t("intro.faq.expiry.a", { count: expiryHours })
                  : t(`intro.faq.${key}.a`)}
              </p>
            </FaqItem>
          ))}
        </ul>
      </div>
    </section>
  );
}
