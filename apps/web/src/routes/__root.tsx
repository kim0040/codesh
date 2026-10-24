import { TooltipProvider } from "@codesh/ui";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../features/app/AppShell";
import { NotFoundScreen } from "../features/app/NotFoundScreen";
import { I18nProvider } from "../lib/i18n";

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
  notFoundComponent: NotFoundScreen,
});
