import { createFileRoute } from "@tanstack/react-router";
import { IntroPage } from "../features/intro/IntroPage";
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
  component: IntroRoute,
});
