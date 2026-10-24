import type { MessageKey } from "@codesh/i18n";
import type { Template } from "@codesh/shared";
import { toast } from "@codesh/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { useT } from "../../lib/i18n";

/** Creating a share, empty or from files, and opening it. */
export function useCreateShare() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const open = async (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["shares"] });
    await navigate({ to: "/$id", params: { id } });
  };

  const fail = (error: unknown) => {
    const text = errorText(error);
    toast({
      title: t(text.title),
      description: text.hint ? t(text.hint) : undefined,
      tone: "danger",
    });
  };

  return {
    pending,
    createEmpty: async () => {
      setPending(true);
      try {
        const created = await api.createShare({});
        await open(created.id);
      } catch (error) {
        fail(error);
      } finally {
        setPending(false);
      }
    },
    /** Creates a share with the files of a template and opens it; true when it worked. */
    createFromTemplate: async (template: Template) => {
      setPending(true);
      try {
        const created = await api.createShare({
          title: template.builtin ? t(template.name as MessageKey) : template.name,
          language: template.language,
          files: template.files,
        });
        await open(created.id);
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        setPending(false);
      }
    },
    createFromFiles: async (files: File[]) => {
      if (files.length === 0) return;
      setPending(true);
      try {
        const created = (await api.upload(files, { asShare: true })) as { id: string };
        await open(created.id);
      } catch {
        toast({ title: t("toast.uploadFailed"), tone: "danger" });
      } finally {
        setPending(false);
      }
    },
  };
}
