import { createFileRoute } from "@tanstack/react-router";
import { NetworkPage } from "../features/guide/NetworkPage";

export const Route = createFileRoute("/guide/network")({
  component: NetworkPage,
});
