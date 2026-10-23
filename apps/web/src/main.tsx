import { registerSW } from "virtual:pwa-register";
import { applyStoredTheme } from "@codesh/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { queryClient } from "./lib/query";
import { routeTree } from "./routeTree.gen";

applyStoredTheme();

const router = createRouter({
  routeTree,
  // Route changes cross-fade through the View Transitions API; browsers without it just switch,
  // and prefers-reduced-motion switches the animation off in index.css.
  defaultViewTransition: true,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
