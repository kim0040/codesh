import type { MessageKey } from "@gachipad/i18n";

/** The guide pages in reading order: the header, the footer and the previous/next links share it. */
export const GUIDE_PAGES = [
  { slug: "how", to: "/guide/how", navKey: "intro.nav.how" },
  { slug: "features", to: "/guide/features", navKey: "intro.nav.features" },
  { slug: "network", to: "/guide/network", navKey: "intro.nav.network" },
  { slug: "security", to: "/guide/security", navKey: "intro.nav.security" },
  { slug: "faq", to: "/guide/faq", navKey: "intro.nav.faq" },
] as const satisfies readonly { slug: string; to: string; navKey: MessageKey }[];

export type GuideSlug = (typeof GUIDE_PAGES)[number]["slug"];

/** Where the old one-page anchors (`/#how`) lead now. */
export const LEGACY_ANCHORS: Readonly<Record<string, (typeof GUIDE_PAGES)[number]["to"]>> = {
  how: "/guide/how",
  fast: "/guide/network",
  features: "/guide/features",
  different: "/guide/security",
  faq: "/guide/faq",
};
