import { createT } from "@codesh/i18n";
import { createFileRoute } from "@tanstack/react-router";

const t = createT("ko");

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-4">
      <h1 className="font-mono text-4xl font-semibold">{t("app.name")}</h1>
      <p className="text-lg">{t("app.tagline")}</p>
    </main>
  );
}
