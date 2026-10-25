import type { ComponentType } from "react";
import { useT } from "../../../lib/i18n";
import {
  AccessArt,
  DownloadArt,
  FilesArt,
  HighlightArt,
  HistoryArt,
  KeysArt,
  MergeArt,
} from "../art";
import { reveal } from "../reveal";
import { SectionHead } from "./SectionHead";

const FEATURES = [
  { key: "highlight", span: 7, Art: HighlightArt },
  { key: "merge", span: 5, Art: MergeArt },
  { key: "access", span: 5, Art: AccessArt },
  { key: "files", span: 7, Art: FilesArt },
  { key: "history", span: 7, Art: HistoryArt },
  { key: "download", span: 5, Art: DownloadArt },
  { key: "keys", span: 12, Art: KeysArt },
] as const satisfies readonly { key: string; span: number; Art: ComponentType }[];

export function FeaturesSection() {
  const t = useT();
  return (
    <section className="ix-section" aria-labelledby="ix-features-title">
      <div className="ix-wrap">
        <SectionHead
          id="ix-features-title"
          title={t("intro.features.title")}
          sub={t("intro.features.sub")}
          more="features"
        />
        <div className="ix-tiles">
          {FEATURES.map(({ key, span, Art }, index) => (
            <article className="ix-tile" data-span={span} key={key} {...reveal((index % 2) * 90)}>
              <Art />
              <div className="ix-tile-text">
                <h3 className="ix-tile-title">{t(`intro.features.${key}.title`)}</h3>
                <p>{t(`intro.features.${key}.body`)}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
