import { createFileRoute } from "@tanstack/react-router";
import { FeaturesPage } from "../features/guide/FeaturesPage";

export const Route = createFileRoute("/guide/features")({
  component: FeaturesPage,
});
