import { createFileRoute, redirect } from "@tanstack/react-router";
import { IntroPage } from "../features/intro/IntroPage";
import { LEGACY_ANCHORS } from "../features/intro/nav";
import { usePublicSettings } from "../lib/public-settings";

/** The intro page quotes the admin's contact and share lifetime once the settings arrive. */
function IntroRoute() {
  const settings = usePublicSettings();
  return (
    <IntroPage
      settings={
        settings
          ? { contact: settings.contact, anonymousTtlHours: settings.anonymousTtlHours }
          : undefined
      }
    />
  );
}

export const Route = createFileRoute("/")({
  // The sections of the old one-page site (`/#how`) are pages now; links to them keep working.
  beforeLoad: ({ location }) => {
    const to = Object.hasOwn(LEGACY_ANCHORS, location.hash)
      ? LEGACY_ANCHORS[location.hash]
      : undefined;
    if (to) throw redirect({ to, replace: true });
  },
  component: IntroRoute,
});
