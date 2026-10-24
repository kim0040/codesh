import { reveal } from "../reveal";

export interface SectionHeadProps {
  id: string;
  title: string;
  /** One sentence under the heading. */
  sub?: string;
}

/** Heading and one-line intro, the same stack and spacing at the top of every section. */
export function SectionHead({ id, title, sub }: SectionHeadProps) {
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
    </div>
  );
}
