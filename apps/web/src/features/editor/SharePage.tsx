import { isJoinCode, isShareId, type Role } from "@codesh/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiError } from "../../lib/api";
import type { JoinCredentials } from "../../lib/collab/session";
import { errorText } from "../../lib/errors";
import { useSseEvent } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { EditorPage } from "./EditorPage";
import {
  DeniedScreen,
  ExpiredScreen,
  KickedScreen,
  LoadFailedScreen,
  LoadingScreen,
  NotFoundShare,
  PinGate,
  WaitingRoom,
} from "./gates";

type JoinState =
  | { phase: "loading" }
  | { phase: "pin"; invalid: boolean; rateLimited: boolean; busy: boolean }
  | { phase: "waiting" }
  | { phase: "denied" }
  | { phase: "banned" }
  | { phase: "notfound" }
  | { phase: "expired" }
  | { phase: "error"; error: unknown }
  | { phase: "ready"; role: Role; credentials: JoinCredentials };

/**
 * `/:id` for a 6-digit join code resolves the code and redirects; for a share id it runs the
 * join (PIN, waiting room, bans) and only then mounts the editor.
 */
export function SharePage({ idOrCode, editKey }: { idOrCode: string; editKey?: string }) {
  if (isJoinCode(idOrCode)) return <CodeResolver code={idOrCode} />;
  if (!isShareId(idOrCode)) return <NotFoundShare />;
  return <JoinGate shareId={idOrCode} editKey={editKey} />;
}

function CodeResolver({ code }: { code: string }) {
  const t = useT();
  const navigate = useNavigate();
  const resolved = useQuery({
    queryKey: ["code", code],
    queryFn: () => api.resolveCode(code),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    const data = resolved.data;
    if (!data) return;
    if ("id" in data) void navigate({ to: "/$id", params: { id: data.id }, replace: true });
    else void navigate({ to: "/lab/$id", params: { id: data.labId }, replace: true });
  }, [resolved.data, navigate]);

  if (resolved.isError) {
    if (isApiError(resolved.error, "not_found") || isApiError(resolved.error, "expired")) {
      return <NotFoundShare />;
    }
    const text = errorText(resolved.error);
    return (
      <LoadFailedScreen
        title={t(text.title)}
        hint={text.hint ? t(text.hint) : undefined}
        onRetry={() => void resolved.refetch()}
      />
    );
  }
  return <LoadingScreen label={t("intro.join.checking")} />;
}

function JoinGate({ shareId, editKey }: { shareId: string; editKey?: string }) {
  const t = useT();
  const session = useSession();
  const [state, setState] = useState<JoinState>({ phase: "loading" });
  const credentialsRef = useRef<JoinCredentials>(editKey ? { editKey } : {});
  const attemptId = useRef(0);

  const attempt = useCallback(
    async (credentials: JoinCredentials) => {
      const id = ++attemptId.current;
      credentialsRef.current = credentials;
      try {
        const result = await api.joinShare(shareId, credentials);
        if (id !== attemptId.current) return;
        if ("token" in result) setState({ phase: "ready", role: result.role, credentials });
        else setState({ phase: "waiting" });
      } catch (error) {
        if (id !== attemptId.current) return;
        if (isApiError(error, "pin_required")) {
          setState({ phase: "pin", invalid: false, rateLimited: false, busy: false });
        } else if (isApiError(error, "pin_invalid")) {
          setState({ phase: "pin", invalid: true, rateLimited: false, busy: false });
        } else if (isApiError(error, "rate_limited")) {
          setState({ phase: "pin", invalid: false, rateLimited: true, busy: false });
        } else if (isApiError(error, "banned")) setState({ phase: "banned" });
        else if (isApiError(error, "not_found")) setState({ phase: "notfound" });
        else if (isApiError(error, "expired")) setState({ phase: "expired" });
        else if (isApiError(error, "forbidden")) setState({ phase: "denied" });
        else setState({ phase: "error", error });
      }
    },
    [shareId],
  );

  const sessionReady = Boolean(session.data);
  useEffect(() => {
    if (!sessionReady) return;
    setState({ phase: "loading" });
    void attempt(editKey ? { editKey } : {});
    return () => {
      attemptId.current++;
    };
  }, [sessionReady, attempt, editKey]);

  // Waiting room: the owner's answer arrives as an event; a slow poll covers a missed one.
  useSseEvent("approval-result", (result) => {
    if (result.shareId !== shareId) return;
    if (result.approved) void attempt(credentialsRef.current);
    else setState({ phase: "denied" });
  });
  const waiting = state.phase === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      void api
        .getShare(shareId)
        .then((share) => {
          if (share.role) void attempt(credentialsRef.current);
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [waiting, shareId, attempt]);

  if (session.isError) {
    const text = errorText(session.error);
    return (
      <LoadFailedScreen
        title={t(text.title)}
        hint={text.hint ? t(text.hint) : undefined}
        onRetry={() => void session.refetch()}
      />
    );
  }

  switch (state.phase) {
    case "loading":
      return <LoadingScreen />;
    case "pin":
      return (
        <PinGate
          invalid={state.invalid}
          rateLimited={state.rateLimited}
          busy={state.busy}
          onSubmit={(pin) => {
            setState({ ...state, busy: true });
            void attempt({ ...credentialsRef.current, pin });
          }}
        />
      );
    case "waiting":
      return (
        <WaitingRoom
          onCancel={() => {
            window.history.length > 1 ? window.history.back() : window.location.assign("/");
          }}
        />
      );
    case "denied":
      return <DeniedScreen />;
    case "banned":
      return <KickedScreen banned />;
    case "notfound":
      return <NotFoundShare />;
    case "expired":
      return <ExpiredScreen />;
    case "error": {
      const text = errorText(state.error);
      return (
        <LoadFailedScreen
          title={t(text.title)}
          hint={text.hint ? t(text.hint) : undefined}
          onRetry={() => void attempt(credentialsRef.current)}
        />
      );
    }
    case "ready":
      if (!session.data) return <LoadingScreen />;
      return (
        <EditorPage
          shareId={shareId}
          role={state.role}
          credentials={state.credentials}
          me={{
            clientId: session.data.clientId,
            name: session.data.name ?? "",
            color: session.data.color,
          }}
        />
      );
  }
}
