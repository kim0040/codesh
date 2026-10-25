import { isJoinCode, isShareId, type Role } from "@codesh/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiError } from "../../lib/api";
import type { JoinCredentials } from "../../lib/collab/session";
import { isKeyRemembered, noteKeyAdmitted, useLinkKey } from "../../lib/credentials";
import { isDenial, leaveAfterDenial, leaveBeforeChallenge } from "../../lib/device";
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
  | { phase: "ready"; attempt: number; role: Role; credentials: JoinCredentials };

/**
 * `/:id` for a 6-digit join code resolves the code and redirects; for a share id it runs the
 * join (PIN, waiting room, bans) and only then mounts the editor.
 */
export function SharePage({ idOrCode }: { idOrCode: string }) {
  if (isJoinCode(idOrCode)) return <CodeResolver code={idOrCode} />;
  if (!isShareId(idOrCode)) return <NotFoundShare />;
  // One gate per share: credentials and attempts never carry over to another one.
  return <JoinGate key={idOrCode} shareId={idOrCode} />;
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

function JoinGate({ shareId }: { shareId: string }) {
  const t = useT();
  const session = useSession();
  const editKey = useLinkKey(shareId);
  const [state, setState] = useState<JoinState>({ phase: "loading" });
  const credentialsRef = useRef<JoinCredentials>(editKey ? { editKey } : {});
  const attemptId = useRef(0);
  // A PIN or an approval was asked for: the offline copy waits for the server's say (session.ts).
  const sensitiveRef = useRef(false);
  // The open document ended with edits the server had not confirmed; the gate says so.
  const [lostEdits, setLostEdits] = useState(false);

  const attempt = useCallback(
    async (credentials: JoinCredentials) => {
      const id = ++attemptId.current;
      credentialsRef.current = credentials;
      /**
       * A PIN or approval asked for at the door, not in answer to a PIN typed here: whatever an
       * earlier visit left (a copy, a key that let this tab in) goes before the gate shows. A key
       * the link just brought stays with this gate for the next attempt.
       */
      const challenge = async (next: JoinState) => {
        sensitiveRef.current = true;
        if (!credentials.pin) {
          const remembered = isKeyRemembered(shareId);
          if (remembered) credentialsRef.current = {};
          await leaveBeforeChallenge(shareId, remembered);
          if (id !== attemptId.current) return;
        }
        setState(next);
      };
      try {
        const result = await api.joinShare(shareId, credentials);
        if (id !== attemptId.current) return;
        if ("token" in result) {
          if (credentials.editKey) noteKeyAdmitted(shareId);
          setLostEdits(false);
          setState({ phase: "ready", attempt: id, role: result.role, credentials });
        } else await challenge({ phase: "waiting" });
      } catch (error) {
        if (id !== attemptId.current) return;
        // The server's own refusal: a copy and a key from an earlier visit go, also when no
        // document is open (the tab was closed when the ban came).
        if (isDenial(error)) {
          credentialsRef.current = {};
          void leaveAfterDenial(shareId);
        }
        if (isApiError(error, "pin_required")) {
          await challenge({ phase: "pin", invalid: false, rateLimited: false, busy: false });
        } else if (isApiError(error, "pin_invalid")) {
          await challenge({ phase: "pin", invalid: true, rateLimited: false, busy: false });
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

  // The key this gate joined with; undefined before the first join.
  const joinedWith = useRef<{ key: string | undefined } | undefined>(undefined);
  const sessionReady = Boolean(session.data);
  useEffect(() => {
    if (!sessionReady) return;
    // A new key (pasted link) joins again; a dropped key (forget, denial) is cleanup, not a join.
    const joined = joinedWith.current;
    if (joined && (editKey === undefined || editKey === joined.key)) return;
    joinedWith.current = { key: editKey };
    setState({ phase: "loading" });
    void attempt(editKey ? { editKey } : {});
  }, [sessionReady, attempt, editKey]);
  useEffect(
    () => () => {
      attemptId.current++;
      joinedWith.current = undefined;
    },
    [],
  );

  /** The open document left the share. A PIN or approval asked for anew starts the join over. */
  const onLeft = useCallback(
    (rejoin: boolean, lost: boolean) => {
      credentialsRef.current = {};
      setLostEdits(lost);
      if (rejoin) {
        setState({ phase: "loading" });
        void attempt({});
      } else
        setState((current) =>
          current.phase === "ready" ? { ...current, credentials: {} } : current,
        );
    },
    [attempt],
  );

  // Waiting room: the owner's answer arrives as an event; a slow poll covers a missed one.
  useSseEvent("approval-result", (result) => {
    if (result.shareId !== shareId) return;
    if (result.approved) void attempt(credentialsRef.current);
    else {
      credentialsRef.current = {};
      void leaveAfterDenial(shareId);
      setState({ phase: "denied" });
    }
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
          lostEdits={lostEdits}
          onSubmit={(pin) => {
            setState({ ...state, busy: true });
            void attempt({ ...credentialsRef.current, pin });
          }}
        />
      );
    case "waiting":
      return (
        <WaitingRoom
          lostEdits={lostEdits}
          onCancel={() => {
            window.history.length > 1 ? window.history.back() : window.location.assign("/");
          }}
        />
      );
    case "denied":
      return <DeniedScreen lostEdits={lostEdits} />;
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
      // A fast join can batch loading and ready: replace the old session even then.
      return (
        <EditorPage
          key={state.attempt}
          shareId={shareId}
          role={state.role}
          credentials={state.credentials}
          sensitive={sensitiveRef.current}
          onLeft={onLeft}
          me={{
            clientId: session.data.clientId,
            name: session.data.name ?? "",
            color: session.data.color,
          }}
        />
      );
  }
}
