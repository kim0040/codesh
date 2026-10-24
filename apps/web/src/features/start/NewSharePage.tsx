import { toast } from "@codesh/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { LoadingScreen } from "../editor/gates";

/** `/new` creates an empty share and replaces itself with it, so Back never lands here again. */
export function NewSharePage() {
  const t = useT();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .createShare({})
      .then((created) => navigate({ to: "/$id", params: { id: created.id }, replace: true }))
      .catch((error) => {
        const text = errorText(error);
        toast({ title: t(text.title), tone: "danger" });
        void navigate({ to: "/", replace: true });
      });
  }, [navigate, t]);

  return <LoadingScreen label={t("common.loading")} />;
}
