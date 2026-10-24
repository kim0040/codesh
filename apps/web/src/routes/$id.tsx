import { createFileRoute } from "@tanstack/react-router";
import { SharePage } from "../features/editor/SharePage";

export const Route = createFileRoute("/$id")({
  component: function ShareRoute() {
    const { id } = Route.useParams();
    return <SharePage idOrCode={id} />;
  },
});
