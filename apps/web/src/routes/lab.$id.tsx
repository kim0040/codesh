import { createFileRoute } from "@tanstack/react-router";
import { LabPage } from "../features/lab/LabPage";

export const Route = createFileRoute("/lab/$id")({
  component: function LabRoute() {
    const { id } = Route.useParams();
    return <LabPage idOrCode={id} />;
  },
});
