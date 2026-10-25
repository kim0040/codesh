import "./lib/storage-migration";
import { applyStoredTheme } from "@gachipad/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { startAppUpdates } from "./lib/app-update";
import { captureKeyFromUrl, watchKeyInUrl } from "./lib/credentials";
import { hasSeenSession, listenForForgetting } from "./lib/device";
import { installDiagnostics } from "./lib/diagnostics";
import { queryClient } from "./lib/query";
import { sessionQuery } from "./lib/session";
import { initializeLegacyDatabases } from "./lib/storage-migration";
import { routeTree } from "./routeTree.gen";

// An edit key in the address (`#key=` or a legacy `?key=`) moves into memory before the router
// reads the location, so it never reaches router state or history.
captureKeyFromUrl();
const router = createRouter({
  routeTree,
  // Route changes cross-fade through the View Transitions API; browsers without it just switch,
  // and prefers-reduced-motion switches the animation off in index.css.
  defaultViewTransition: true,
  defaultPreload: "intent",
});

// Start the first route's imports before load can fire; a cancelled late import can trigger the
// router's stale-chunk reload while the browser is already navigating to another document.
void router.load();
await initializeLegacyDatabases();
installDiagnostics();
applyStoredTheme();
listenForForgetting();
// A different account than the last one on this device must not inherit its offline copies, also
// when the first screen never asks who is signed in.
if (hasSeenSession()) void queryClient.prefetchQuery(sessionQuery);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

watchKeyInUrl((url) => router.history.replace(url));

// Service worker in prompt mode and the server version checks (lib/app-update.ts).
startAppUpdates();

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
