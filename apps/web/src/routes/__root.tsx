import { Button, TooltipProvider } from "@gachipad/ui";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "../features/app/AppShell";
import { NotFoundScreen } from "../features/app/NotFoundScreen";
import { captureDiagnosticError } from "../lib/diagnostics";
import { I18nProvider, useT } from "../lib/i18n";

export const Route = createRootRoute({
  component: () => (
    <I18nProvider>
      <TooltipProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </TooltipProvider>
    </I18nProvider>
  ),
  errorComponent: ({ error, reset }) => (
    <I18nProvider>
      <RenderError error={error} reset={reset} />
    </I18nProvider>
  ),
  notFoundComponent: NotFoundScreen,
});

function RenderError({ error, reset }: { error: unknown; reset: () => void }) {
  const t = useT();
  useEffect(() => captureDiagnosticError("render", error), [error]);
  return (
    <main id="main" className="mx-auto flex max-w-md flex-col gap-4 p-5">
      <h1>{t("settings.diag.renderError")}</h1>
      <Button onClick={reset}>{t("common.retry")}</Button>
    </main>
  );
}
