import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "../features/guide/SecurityPage";

export const Route = createFileRoute("/guide/security")({
  component: SecurityPage,
});
