import { Button, EmptyState } from "@codesh/ui";
import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { useT } from "../../lib/i18n";

export function NotFoundScreen() {
  const t = useT();
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <EmptyState
        headingLevel={1}
        icon={<SearchX />}
        title={t("error.not_found")}
        description={t("error.not_found.hint")}
        action={
          <Button asChild variant="primary">
            <Link to="/">{t("error.page.homeAction")}</Link>
          </Button>
        }
      />
    </main>
  );
}
