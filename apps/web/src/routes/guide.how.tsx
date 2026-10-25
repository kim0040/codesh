import { createFileRoute } from "@tanstack/react-router";
import { HowPage } from "../features/guide/HowPage";

export const Route = createFileRoute("/guide/how")({
  component: HowPage,
});
