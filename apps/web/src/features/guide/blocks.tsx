import { Link, useRouterState } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";
import { PLATFORM, type Platform } from "../../lib/platform";
import { chordKeys, chordsFor, type ShortcutId } from "../../lib/shortcuts";
import { useFocusOnArrival } from "../intro/arrival";
import { usePrefersReducedMotion, useScrollReveal } from "../intro/hooks";
import { ArrowRightIcon } from "../intro/icons";
import { GUIDE_PAGES, type GuideSlug } from "../intro/nav";
import { reveal } from "../intro/reveal";
import { useGuide } from "./copy";
import { fragmentId } from "./fragment";

export interface TocItem {
  id: string;
  label: string;
}

/**
 * The frame every guide page shares: title, lead, a table of contents beside (or above) the
 * sections, and the links to the neighbouring pages. It owns the scroll reveal of its parts, since
 * the page mounts after the layout (the text loads first).
 */
export function GuidePage({
  slug,
  title,
  lead,
  toc,
  children,
}: {
  slug: GuideSlug;
  title: string;
  lead: string;
  toc?: readonly TocItem[];
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  useScrollReveal(root, reduced);
  // Reached through the app, the page starts with focus on its title (the text has loaded by now).
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusOnArrival(heading);
  // The page mounts after its text has loaded, so the browser's own jump to #<id> found nothing;
  // a later change of the fragment (Back, Forward, a link on the page) comes through here too.
  const hash = useRouterState({ select: (state) => state.location.hash });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the router's hash says the address changed
  useEffect(() => {
    const id = fragmentId(window.location.hash);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash]);
  return (
    <div className="ix-page" ref={root}>
      <div className="ix-wrap">
        <div className="ix-gh">
          <h1 className="ix-gh1" ref={heading} tabIndex={-1} {...reveal()}>
            {title}
          </h1>
          <p className="ix-lead" {...reveal(70)}>
            {lead}
          </p>
        </div>
        <div className="ix-gbody" data-toc={toc ? "" : undefined}>
          {toc ? <Toc items={toc} /> : null}
          <div className="ix-gmain">{children}</div>
        </div>
        <PrevNext slug={slug} />
      </div>
    </div>
  );
}

function Toc({ items }: { items: readonly TocItem[] }) {
  const { t } = useGuide();
  return (
    <nav className="ix-toc" aria-labelledby="ix-toc-title">
      <p id="ix-toc-title" className="ix-toc-title">
        {t("guide.toc.title")}
      </p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`}>{item.label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A titled part of a page. The id is the anchor the table of contents and old links point to. */
export function GSection({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="ix-gsec" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="ix-gh2" {...reveal()}>
        {title}
      </h2>
      {lead ? (
        <p className="ix-glead" {...reveal(60)}>
          {lead}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function P({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <p className="ix-gp" {...reveal(delay)}>
      {children}
    </p>
  );
}

export interface CardItem {
  title: string;
  body: ReactNode;
}

/** Short items side by side: a heading and a few words each, on a step in tone. */
export function Cards({ items, wide = false }: { items: readonly CardItem[]; wide?: boolean }) {
  return (
    <ul className="ix-gcards" data-wide={wide ? "" : undefined}>
      {items.map((item, index) => (
        <li className="ix-gcard" key={item.title} {...reveal((index % 3) * 70)}>
          <h3>{item.title}</h3>
          <p>{item.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** A drawing from the home page with its explanation: the drawing is decorative. */
export function Row({
  Art,
  title,
  body,
  flip = false,
}: {
  Art: ComponentType;
  title: string;
  body: string;
  flip?: boolean;
}) {
  return (
    <li className="ix-grow" data-flip={flip ? "" : undefined} {...reveal()}>
      <div className="ix-gart" aria-hidden="true">
        <Art />
      </div>
      <div className="ix-grow-text">
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </li>
  );
}

/** A mock-up of a real screen: built from the app's own components, never reachable by keyboard. */
export function Mock({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="ix-gfig" {...reveal()}>
      <div className="ix-mock" data-ui aria-hidden="true" inert>
        {children}
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="ix-keys">
      {keys.map((key, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a chord can repeat a key name
        <kbd className="ix-kbd" key={index}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** The chords of one shortcut for a platform; alternatives are separated by a slash. */
export function ShortcutKeys({ id, platform = PLATFORM }: { id: ShortcutId; platform?: Platform }) {
  const chords = chordsFor(id, platform);
  return (
    <span className="ix-chords">
      {chords.map((chord, index) => (
        <span key={chordKeys(chord, platform).join("+")}>
          {index > 0 ? <span className="ix-chord-or">/</span> : null}
          <Keys keys={chordKeys(chord, platform)} />
        </span>
      ))}
    </span>
  );
}

export function Yes({ yes }: { yes: boolean }) {
  const { t } = useGuide();
  return <span data-yes={yes ? "" : undefined}>{t(yes ? "guide.yes" : "guide.no")}</span>;
}

/** Previous and next guide, in the order of the header. */
function PrevNext({ slug }: { slug: GuideSlug }) {
  const t = useT();
  const { t: g } = useGuide();
  const index = GUIDE_PAGES.findIndex((page) => page.slug === slug);
  const prev = GUIDE_PAGES[index - 1];
  const next = GUIDE_PAGES[index + 1];
  return (
    <nav className="ix-pn" aria-label={g("guide.nav.label")}>
      {prev ? (
        <Link to={prev.to} className="ix-pn-link" data-dir="prev" rel="prev">
          <span className="ix-pn-dir">{g("guide.nav.prev")}</span>
          <span className="ix-pn-name">{t(prev.navKey)}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link to={next.to} className="ix-pn-link" data-dir="next" rel="next">
          <span className="ix-pn-dir">{g("guide.nav.next")}</span>
          <span className="ix-pn-name">
            {t(next.navKey)}
            <ArrowRightIcon />
          </span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** Text on one side and a decorative drawing on the other; they stack on narrow screens. */
export function Split({
  Art,
  flip = false,
  children,
}: {
  Art: ComponentType;
  flip?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="ix-gsplit" data-flip={flip ? "" : undefined}>
      <div className="ix-gsplit-text">{children}</div>
      <div className="ix-gart" aria-hidden="true" {...reveal(90)}>
        <Art />
      </div>
    </div>
  );
}
