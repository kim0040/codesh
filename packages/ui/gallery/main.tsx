import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./gallery.css";
import { Moon, Sun } from "lucide-react";
import {
  Button,
  getStoredTheme,
  IconButton,
  setTheme,
  Tabs,
  TabsList,
  TabsTrigger,
  type ThemePreference,
  Toaster,
  TooltipProvider,
} from "../src/index.js";
import { ComponentsView } from "./components.js";
import { EditorsView } from "./editors.js";
import { TokensView } from "./tokens.js";

type View = "components" | "editors" | "tokens";
const VIEWS: View[] = ["components", "editors", "tokens"];

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const theme = params.get("theme");
  return {
    view: (VIEWS as string[]).includes(view ?? "") ? (view as View) : "components",
    theme: theme === "dark" ? ("dark" as const) : theme === "light" ? ("light" as const) : null,
  };
}

function App() {
  const initial = readParams();
  const [view, setView] = useState<View>(initial.view);
  const [theme, setThemeState] = useState<ThemePreference>(initial.theme ?? getStoredTheme());

  useEffect(() => {
    setTheme(theme);
  }, [theme]);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
  }, [view]);

  return (
    <TooltipProvider>
      <header className="sticky top-0 z-(--z-sticky) border-b border-line bg-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <h1 className="text-title-sm font-semibold">
            gachipad <span className="font-normal text-fg-3">UI gallery</span>
          </h1>
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList variant="segmented" aria-label="Gallery view">
              {VIEWS.map((v) => (
                <TabsTrigger key={v} value={v}>
                  {v}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="ms-auto flex items-center gap-1">
            <Button
              size="sm"
              variant={theme === "system" ? "soft" : "ghost"}
              onClick={() => setThemeState("system")}
            >
              system
            </Button>
            <IconButton
              aria-label="Dark theme"
              pressed={theme === "dark"}
              onClick={() => setThemeState("dark")}
            >
              <Moon />
            </IconButton>
            <IconButton
              aria-label="Light theme"
              pressed={theme === "light"}
              onClick={() => setThemeState("light")}
            >
              <Sun />
            </IconButton>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8" data-view={view}>
        {view === "components" ? <ComponentsView /> : null}
        {view === "editors" ? <EditorsView /> : null}
        {view === "tokens" ? <TokensView /> : null}
      </main>
      <Toaster label="알림" closeLabel="닫기" />
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
