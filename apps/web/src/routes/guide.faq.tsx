import { createFileRoute } from "@tanstack/react-router";
import { FaqPage } from "../features/guide/FaqPage";

export const Route = createFileRoute("/guide/faq")({
  component: FaqPage,
});
