import type { GuideSlug } from "../nav";
import { reveal } from "../reveal";
import { MoreLink } from "./MoreLink";

export interface SectionHeadProps {
  id: string;
  title: string;
  /** One sentence under the heading. */
  sub?: string;
  /** The guide page this section summarises; adds a "read more" link to it. */
  more?: GuideSlug;
}

/** Heading and one-line intro, the same stack and spacing at the top of every section. */
export function SectionHead({ id, title, sub, more }: SectionHeadProps) {
  return (
    <div className="ix-head">
      <h2 id={id} className="ix-h2" {...reveal()}>
        {title}
      </h2>
      {sub ? (
        <p className="ix-lead" {...reveal(70)}>
          {sub}
        </p>
      ) : null}
      {more ? (
        <div {...reveal(130)}>
          <MoreLink page={more} />
        </div>
      ) : null}
    </div>
  );
}
