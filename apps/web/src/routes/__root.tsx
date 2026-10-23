import { createRootRoute, Outlet } from "@tanstack/react-router";
import { I18nProvider } from "../lib/i18n";

export const Route = createRootRoute({
  component: () => (
    <I18nProvider>
      <Outlet />
    </I18nProvider>
  ),
});
