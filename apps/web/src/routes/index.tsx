import { createFileRoute } from "@tanstack/react-router";
import { IntroPage } from "../features/intro/IntroPage";

export const Route = createFileRoute("/")({
  component: IntroPage,
});
