import { createFileRoute } from "@tanstack/react-router";
import { SharePage } from "../features/editor/SharePage";

export const Route = createFileRoute("/$id")({
  validateSearch: (search: Record<string, unknown>): { key?: string } =>
    typeof search.key === "string" && search.key ? { key: search.key } : {},
  component: function ShareRoute() {
    const { id } = Route.useParams();
    const { key } = Route.useSearch();
    return <SharePage idOrCode={id} editKey={key} />;
  },
});
