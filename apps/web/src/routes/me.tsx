import { createFileRoute } from "@tanstack/react-router";
import { MySharesPage } from "../features/me/MySharesPage";

export const Route = createFileRoute("/me")({
  component: MySharesPage,
});
