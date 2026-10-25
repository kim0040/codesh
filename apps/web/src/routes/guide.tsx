import { createFileRoute } from "@tanstack/react-router";
import { GuideLayout } from "../features/guide/GuideLayout";

/** The guide pages share a header, a footer and the lazily loaded text. */
export const Route = createFileRoute("/guide")({
  component: GuideLayout,
});
