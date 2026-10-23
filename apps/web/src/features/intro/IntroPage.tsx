import { useT } from "../../lib/i18n";
import { StartPanel } from "../start/StartPanel";

/**
 * Placeholder: the intro worker replaces this file with the real page, which embeds StartPanel.
 */
export function IntroPage() {
  const t = useT();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-mono text-heading font-semibold">{t("app.name")}</h1>
        <p className="text-body text-fg-2">{t("intro.hero.sub")}</p>
      </header>
      <StartPanel />
    </main>
  );
}
