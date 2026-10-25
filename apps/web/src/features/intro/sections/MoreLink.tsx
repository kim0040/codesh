import { Link } from "@tanstack/react-router";
import { useT } from "../../../lib/i18n";
import { ArrowRightIcon } from "../icons";
import { GUIDE_PAGES, type GuideSlug } from "../nav";

/** "Read more" under a home section; the page it leads to is part of the link's name. */
export function MoreLink({ page, faq = false }: { page: GuideSlug; faq?: boolean }) {
  const t = useT();
  const target = GUIDE_PAGES.find((entry) => entry.slug === page) ?? GUIDE_PAGES[0];
  return (
    <Link to={target.to} className="ix-more">
      {t(faq ? "intro.more.faqAction" : "intro.more.action")}
      <span className="ix-sr">: {t(target.navKey)}</span>
      <ArrowRightIcon />
    </Link>
  );
}
