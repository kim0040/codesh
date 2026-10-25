import type { Settings } from "@gachipad/shared";
import { Button, toast } from "@gachipad/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { TemplatesEditor } from "./TemplatesEditor";

/** The same template tools as settings, with a dedicated operator entry point. */
export function TemplatesPanel({ token, initial }: { token: string; initial: Settings }) {
  const t = useT();
  const cache = useQueryClient();
  const [templates, setTemplates] = useState(initial.templates);
  useEffect(() => setTemplates(initial.templates), [initial.templates]);
  const dirty = JSON.stringify(templates) !== JSON.stringify(initial.templates);
  const save = useMutation({
    mutationFn: async () => {
      const latest = await api.admin.settings(token);
      return api.admin.putSettings(token, { ...latest, templates });
    },
    onSuccess: (settings) => {
      cache.setQueryData(["admin", "settings"], settings);
      toast({ title: t("admin.saved"), tone: "success" });
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      data-testid="admin-templates"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <TemplatesEditor
        templates={templates}
        maxDocBytes={initial.maxDocBytes}
        onChange={setTemplates}
      />
      {save.isError && (
        <p role="alert" className="text-body-sm text-danger-text">
          {t("admin.error.body")}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={!dirty || save.isPending} onClick={() => setTemplates(initial.templates)}>
          {t("admin.discardAction")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          loadingLabel={t("common.loading")}
        >
          {t("admin.saveAction")}
        </Button>
      </div>
    </form>
  );
}
