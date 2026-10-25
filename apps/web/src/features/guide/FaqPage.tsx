import { useState } from "react";
import { useT } from "../../lib/i18n";
import { GuidePage } from "./blocks";
import { useGuide, useGuideTitle } from "./copy";
import { FACTS } from "./facts";
import { type FaqEntry, FaqGroup } from "./parts";

/** Questions by topic. Ids double as anchors (`/guide/faq#expiry`). */
const GROUPS = [
  { id: "start", keys: ["expiry", "save", "account", "phone", "run"] },
  { id: "people", keys: ["security", "cantEdit", "pin", "notNearby", "codeFails"] },
  { id: "edit", keys: ["languages", "offline", "size", "folder", "history"] },
  { id: "network", keys: ["outside", "internet", "tracking", "shared", "contact"] },
] as const;

/** Questions that were on the home page keep their texts there. */
const FROM_HOME = new Set(["expiry", "save", "security", "languages", "outside", "phone"]);

function initialOpen(): Set<string> {
  const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  return new Set(hash ? [hash] : ["expiry"]);
}

export function FaqPage() {
  const { t, settings } = useGuide();
  const app = useT();
  useGuideTitle(t("guide.faq.title"));
  const [open, setOpen] = useState(initialOpen);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const entry = (key: string): FaqEntry => {
    if (FROM_HOME.has(key)) {
      const answer =
        key === "expiry"
          ? app("intro.faq.expiry.a", { count: settings.expiryHours })
          : app(`intro.faq.${key as "save"}.a`);
      return { id: key, question: app(`intro.faq.${key as "save"}.q`), answer };
    }
    const params = { upload: settings.uploadMB, max: FACTS.files };
    return {
      id: key,
      question: t(`guide.faq.${key as "account"}.q`),
      answer: t(`guide.faq.${key as "account"}.a`, params),
    };
  };

  const toc = GROUPS.map(({ id }) => ({ id, label: t(`guide.faq.group.${id}`) }));

  return (
    <GuidePage slug="faq" title={t("guide.faq.title")} lead={t("guide.faq.lead")} toc={toc}>
      {GROUPS.map(({ id, keys }) => (
        <div id={id} key={id} className="ix-ganchor">
          <FaqGroup
            title={t(`guide.faq.group.${id}`)}
            entries={keys.map(entry)}
            open={open}
            onToggle={toggle}
          />
        </div>
      ))}
    </GuidePage>
  );
}
