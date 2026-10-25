import { toast } from "@gachipad/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { api } from "../../lib/api";
import { onSseEvent, useSseEvent } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { notifyHidden } from "../../lib/notify";
import { usePrefs } from "../../lib/prefs";

/** Invites, broadcasts and approval requests arrive as SSE events; this turns them into toasts. */
export function EventToasts() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const prefs = usePrefs();
  const seen = useRef(new Set<string>());
  const notificationsOn = prefs.notifications;

  const once = (key: string): boolean => {
    if (seen.current.has(key)) return false;
    seen.current.add(key);
    if (seen.current.size > 100) seen.current.clear();
    return true;
  };

  const open = (shareId: string) => void navigate({ to: "/$id", params: { id: shareId } });

  useSseEvent("invite", (invite) => {
    if (!once(`invite:${invite.shareId}:${invite.from.clientId}:${invite.note ?? ""}`)) return;
    const title = t("invite.received.title", { name: invite.from.name });
    const detail = invite.title || t("common.untitled");
    if (notificationsOn) {
      notifyHidden(title, {
        body: detail,
        tag: `invite-${invite.shareId}`,
        onClick: () => open(invite.shareId),
      });
    }
    toast({
      title,
      description: invite.note ? `${detail} — ${invite.note}` : detail,
      tone: "info",
      action: {
        label: t("invite.acceptAction"),
        altText: t("invite.acceptAction"),
        onClick: () => open(invite.shareId),
      },
    });
    void queryClient.invalidateQueries({ queryKey: ["shares"] });
  });

  useSseEvent("broadcast", (broadcast) => {
    if (!once(`broadcast:${broadcast.shareId}`)) return;
    const title = t("invite.broadcast.title", { name: broadcast.from.name });
    if (notificationsOn) {
      notifyHidden(title, {
        body: broadcast.title,
        tag: `broadcast-${broadcast.shareId}`,
        onClick: () => open(broadcast.shareId),
      });
    }
    toast({
      title,
      description: broadcast.title || t("common.untitled"),
      tone: "info",
      action: {
        label: t("invite.broadcast.joinAction"),
        altText: t("invite.broadcast.joinAction"),
        onClick: () => open(broadcast.shareId),
      },
    });
  });

  useSseEvent("approval-request", (request) => {
    if (!once(`approval:${request.shareId}:${request.clientId}`)) return;
    const title = t("approval.title", { name: request.name });
    if (notificationsOn)
      notifyHidden(title, { tag: `approval-${request.shareId}-${request.clientId}` });
    toast({
      title,
      tone: "warning",
      action: {
        label: t("approval.approveAction"),
        altText: t("approval.approveAction"),
        onClick: () => {
          void api
            .resolvePending(request.shareId, request.clientId, true)
            .then(() => toast({ title: t("toast.approved"), tone: "success" }))
            .catch(() => toast({ title: t("error.generic"), tone: "danger" }));
        },
      },
    });
  });

  return null;
}

export { onSseEvent };
