import { Link } from "@tanstack/react-router";
import { FilesArt, NearbyArt, QrArt } from "../intro/art";
import { reveal } from "../intro/reveal";
import { GSection, GuidePage, P, Split } from "./blocks";
import { useGuide, useGuideTitle } from "./copy";
import { FACTS } from "./facts";

const SECTIONS = ["why", "ways", "groups", "address", "size", "offline"] as const;
const WAYS = ["code", "qr", "nearby", "send", "room"] as const;

export function NetworkPage() {
  const { t, settings } = useGuide();
  useGuideTitle(t("guide.network.title"));
  const toc = SECTIONS.map((id) => ({ id, label: t(`guide.network.toc.${id}`) }));

  return (
    <GuidePage
      slug="network"
      title={t("guide.network.title")}
      lead={t("guide.network.lead")}
      toc={toc}
    >
      <GSection id="why" title={t("guide.network.why.title")}>
        <P>{t("guide.network.why.body1")}</P>
        <P>{t("guide.network.why.body2")}</P>
      </GSection>

      <GSection id="ways" title={t("guide.network.ways.title")}>
        <ul className="ix-gcards ix-gcards-ways">
          {WAYS.map((way, index) => (
            <li className="ix-gcard" key={way} {...reveal(index * 50)}>
              <h3>{t(`guide.how.tell.${way}.title`)}</h3>
              <dl>
                <dt>{t("guide.network.ways.how")}</dt>
                <dd>{t(`guide.network.ways.${way}.how`)}</dd>
                <dt>{t("guide.network.ways.who")}</dt>
                <dd>{t(`guide.network.ways.${way}.who`)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </GSection>

      <GSection id="groups" title={t("guide.network.groups.title")}>
        <Split Art={NearbyArt}>
          <P>{t("guide.network.groups.body1")}</P>
          <P>{t("guide.network.groups.body2")}</P>
          <P>{t("guide.network.groups.body3", { lines: FACTS.nearbyLines })}</P>
          <P>{t("guide.network.groups.body4")}</P>
        </Split>
      </GSection>

      <GSection id="address" title={t("guide.network.address.title")}>
        <Split Art={QrArt} flip>
          <P>{t("guide.network.address.body1")}</P>
          <P>{t("guide.network.address.body2")}</P>
        </Split>
      </GSection>

      <GSection id="size" title={t("guide.network.size.title")}>
        <Split Art={FilesArt}>
          <P>{t("guide.network.size.body1")}</P>
          <P>{t("guide.network.size.body2", { upload: settings.uploadMB })}</P>
          <P>{t("guide.network.size.body3")}</P>
        </Split>
      </GSection>

      <GSection id="offline" title={t("guide.network.offline.title")}>
        <P>{t("guide.network.offline.body1")}</P>
        <P>{t("guide.network.offline.body2")}</P>
        <Link to="/guide/security" hash="external" className="ix-more">
          {t("guide.network.offline.link")}
        </Link>
      </GSection>
    </GuidePage>
  );
}
