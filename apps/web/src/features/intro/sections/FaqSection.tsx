import { useId, useState } from "react";
import { useT } from "../../../lib/i18n";
import { PlusIcon } from "../icons";
import { reveal } from "../reveal";

const FAQ = ["expiry", "save", "security", "languages", "outside", "phone"] as const;

export function FaqSection({ expiryHours }: { expiryHours: number }) {
  const t = useT();
  const base = useId();
  const [open, setOpen] = useState<(typeof FAQ)[number] | null>("expiry");
  return (
    <section id="faq" className="ix-section" aria-labelledby="ix-faq-title">
      <div className="ix-wrap ix-faq">
        <h2 id="ix-faq-title" className="ix-h2 ix-faq-title" {...reveal()}>
          {t("intro.faq.title")}
        </h2>
        <ul className="ix-faq-list">
          {FAQ.map((key, index) => {
            const isOpen = open === key;
            const panelId = `${base}-${key}`;
            return (
              <li
                className="ix-faq-item"
                data-open={isOpen ? "" : undefined}
                key={key}
                {...reveal(index * 50)}
              >
                <h3>
                  <button
                    type="button"
                    className="ix-faq-q"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => setOpen(isOpen ? null : key)}
                  >
                    <span>{t(`intro.faq.${key}.q`)}</span>
                    <PlusIcon className="ix-faq-icon" />
                  </button>
                </h3>
                <section id={panelId} className="ix-faq-panel" aria-label={t(`intro.faq.${key}.q`)}>
                  <div>
                    <p>
                      {key === "expiry"
                        ? t("intro.faq.expiry.a", { count: expiryHours })
                        : t(`intro.faq.${key}.a`)}
                    </p>
                  </div>
                </section>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
