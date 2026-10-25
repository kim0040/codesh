import { useT } from "../../lib/i18n";
import { LICENSES_URL } from "../../lib/licenses";
import { AccessArt } from "../intro/art";
import { Cards, GSection, GuidePage, P, Split } from "./blocks";
import { useGuide, useGuideTitle } from "./copy";

const SECTIONS = [
  "stored",
  "deleted",
  "history",
  "device",
  "external",
  "controls",
  "host",
] as const;
const CONTROLS = [
  "lifetime",
  "history",
  "sizes",
  "guests",
  "rooms",
  "audit",
  "secrets",
  "templates",
] as const;

export function SecurityPage() {
  const { t, settings } = useGuide();
  const app = useT();
  useGuideTitle(t("guide.security.title"));
  const toc = SECTIONS.map((id) => ({ id, label: t(`guide.security.toc.${id}`) }));

  return (
    <GuidePage
      slug="security"
      title={t("guide.security.title")}
      lead={t("guide.security.lead")}
      toc={toc}
    >
      <GSection id="stored" title={t("guide.security.stored.title")}>
        <Cards
          items={(["contents", "people", "access", "audit"] as const).map((key) => ({
            title: t(`guide.security.stored.${key}.title`),
            body: t(`guide.security.stored.${key}.body`),
          }))}
        />
        <p className="ix-gsub">{t("guide.security.stored.how")}</p>
        <ul className="ix-glist">
          <li>{app("intro.faq.expiry.a", { count: settings.expiryHours })}</li>
          <li>{t("guide.security.stored.save")}</li>
          <li>{app("history.retention", { count: settings.historyDays })}</li>
          <li>{t("guide.security.stored.code")}</li>
        </ul>
      </GSection>

      <GSection id="deleted" title={t("guide.security.deleted.title")}>
        <P>{t("guide.security.deleted.body1")}</P>
        <P>{t("guide.security.deleted.body2")}</P>
      </GSection>

      <GSection id="history" title={t("guide.security.history.title")}>
        <Split Art={AccessArt}>
          <P>{t("guide.security.history.body1")}</P>
          <P>{t("guide.security.history.body2")}</P>
        </Split>
      </GSection>

      <GSection id="device" title={t("guide.security.device.title")}>
        <P>{t("guide.security.device.body1")}</P>
        <P>{t("guide.security.device.body2")}</P>
        <p className="ix-gsub">{t("guide.security.device.remove")}</p>
        <Cards
          items={(["forget", "off", "signOut", "auto"] as const).map((key) => ({
            title: t(`guide.security.device.${key}.title`),
            body: t(`guide.security.device.${key}.body`),
          }))}
        />
        <P>{t("guide.security.device.body3")}</P>
      </GSection>

      <GSection id="external" title={t("guide.security.external.title")}>
        <P>{t("guide.security.external.body1")}</P>
        <P>{t("guide.security.external.body2")}</P>
        <P>{t("guide.security.external.body3")}</P>
      </GSection>

      <GSection
        id="controls"
        title={t("guide.security.controls.title")}
        lead={t("guide.security.controls.lead")}
      >
        <ul className="ix-glist">
          {CONTROLS.map((key) => (
            <li key={key}>{t(`guide.security.controls.${key}`)}</li>
          ))}
        </ul>
        <P>{t("guide.security.controls.note")}</P>
      </GSection>

      <GSection id="host" title={t("guide.security.host.title")}>
        <P>{t("guide.security.host.body1")}</P>
        <P>{t("guide.security.host.body2")}</P>
        <a className="ix-more" href={LICENSES_URL} target="_blank" rel="noopener noreferrer">
          {app("intro.footer.licenses")}
          <span className="ix-sr">{app("a11y.opensInNewTab")}</span>
        </a>
      </GSection>
    </GuidePage>
  );
}
