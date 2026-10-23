import { createFileRoute } from "@tanstack/react-router";
import { NewSharePage } from "../features/start/NewSharePage";

export const Route = createFileRoute("/new")({
  component: NewSharePage,
});
