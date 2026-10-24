import type { EditorView } from "@codemirror/view";
import { DEFAULT_FILE_ID, type GetShareResponse, type Role, type UserRef } from "@codesh/shared";
import { toast } from "@codesh/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isApiError } from "../../lib/api";
import { useFiles, useMeta, useParticipants, useSessionState } from "../../lib/collab/hooks";
import { DocSession, type JoinCredentials } from "../../lib/collab/session";
import { isDenial, leaveShare } from "../../lib/device";
import { errorText } from "../../lib/errors";
import { useSseEvent } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { guestNumber } from "../../lib/session";
import { EditorContext, type EditorCtx, type PanelName, type PanelState } from "./context";
import { createInfoStore } from "./doc-info";
import { EditorShell } from "./EditorShell";
import {
  DeniedScreen,
  ExpiredScreen,
  KickedScreen,
  LoadFailedScreen,
  LoadingScreen,
  NotFoundShare,
} from "./gates";
import { useFollow } from "./use-follow";
import { useRtt } from "./use-rtt";

export interface EditorPageProps {
  shareId: string;
  role: Role;
  credentials: JoinCredentials;
  /** The join asked for a PIN or an approval: no local copy is restored before the server accepts. */
  sensitive?: boolean;
  /**
   * The document left the share (forget, denial, logout). `rejoin`: the server asks for a PIN or an
   * approval again, so the join starts over.
   */
  onLeft?: (rejoin: boolean) => void;
  me: UserRef;
}

/** Owns the DocSession for one share and hands everything the editor UI needs through context. */
export function EditorPage({ shareId, role, credentials, sensitive, onLeft, me }: EditorPageProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const shareQuery = useQuery({
    queryKey: ["share", shareId],
    queryFn: ({ signal }) => api.getShare(shareId, signal),
    retry: false,
    staleTime: 10_000,
  });
  const [session, setSession] = useState<DocSession | null>(null);
  // Also sensitive when the share says so (the owner sees its own flags).
  const sensitiveRef = useRef(false);
  sensitiveRef.current =
    Boolean(sensitive) ||
    Boolean(shareQuery.data?.needsPin || shareQuery.data?.requireApproval) ||
    Boolean(shareQuery.data?.access?.hasPin || shareQuery.data?.access?.requireApproval);
  const guest = t("identity.guest", { number: guestNumber(me.clientId) });
  const meName = me.name || guest;

  // The session waits for the share's flags: they decide whether a local copy may be restored.
  const shareReady = shareQuery.data !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session lives as long as the share; name changes are published below
  useEffect(() => {
    if (!shareReady) return;
    const next = new DocSession({
      shareId,
      user: { clientId: me.clientId, name: meName, color: me.color },
      role,
      credentials,
      sensitive: sensitiveRef.current,
      onMerged: () => toast({ title: t("conn.synced"), tone: "success", duration: 3000 }),
      onRole: () => void queryClient.invalidateQueries({ queryKey: ["share", shareId] }),
    });
    setSession(next);
    return () => {
      next.destroy();
      setSession(null);
    };
  }, [shareId, me.clientId, shareReady]);

  // The share is gone or this client is refused: the copy and the key from earlier go too.
  const denied = isDenial(shareQuery.error);
  useEffect(() => {
    if (denied) void leaveShare(shareId);
  }, [denied, shareId]);

  // A change of name or colour reaches the others through awareness.
  useEffect(() => {
    session?.publish({ user: { clientId: me.clientId, name: meName, color: me.color } });
  }, [session, me.clientId, meName, me.color]);

  if (shareQuery.isError) {
    const error = shareQuery.error;
    if (isApiError(error, "not_found")) return <NotFoundShare />;
    if (isApiError(error, "expired")) return <ExpiredScreen />;
    if (isApiError(error, "banned")) return <KickedScreen banned />;
    const text = errorText(error);
    return (
      <LoadFailedScreen
        title={t(text.title)}
        hint={text.hint ? t(text.hint) : undefined}
        onRetry={() => void shareQuery.refetch()}
      />
    );
  }
  if (!session || !shareQuery.data) return <LoadingScreen />;
  return (
    <Connected
      key={session.shareId}
      session={session}
      share={shareQuery.data}
      refetchShare={() => void shareQuery.refetch()}
      me={{ ...me, name: meName }}
      onLeft={onLeft}
    />
  );
}

interface ConnectedProps {
  session: DocSession;
  share: GetShareResponse;
  refetchShare: () => void;
  me: UserRef;
  onLeft?: (rejoin: boolean) => void;
}

function Connected({ session, share, refetchShare, me, onLeft }: ConnectedProps) {
  const state = useSessionState(session);
  const doc = session.doc;
  const files = useFiles(doc);
  const meta = useMeta(doc);
  const participants = useParticipants(session.awareness);
  const viewRef = useRef<EditorView | null>(null);
  const info = useMemo(createInfoStore, []);
  const [panel, setPanel] = useState<PanelState>({ name: null });
  const [activeId, setActiveId] = useState(DEFAULT_FILE_ID);
  const [following, setFollowing] = useState<string | null>(null);
  const [presenting, setPresentingState] = useState(false);
  const [bannedByEvent, setBannedByEvent] = useState<boolean | null>(null);
  const rtt = useRtt(state.status === "connected");
  const isOwner = state.role === "owner";

  useSseEvent("kicked", (event) => {
    if (event.shareId === session.shareId) setBannedByEvent(event.banned);
  });

  const activeFile = files.find((file) => file.id === activeId) ?? files[0];
  const setActiveFileId = useCallback((id: string) => setActiveId(id), []);
  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.id === activeId)) {
      setActiveId(
        (files.find((file) => file.id === DEFAULT_FILE_ID) ?? files[0])?.id ?? DEFAULT_FILE_ID,
      );
    }
  }, [files, activeId]);

  const openPanel = useCallback((name: PanelName, arg?: string) => setPanel({ name, arg }), []);
  const closePanel = useCallback(() => setPanel({ name: null }), []);

  const setPresenting = useCallback(
    (on: boolean) => {
      setPresentingState(on);
      session.publish({ presenting: on ? true : undefined });
      if (on) setFollowing(null);
    },
    [session],
  );

  const follow = useFollow({
    session,
    generation: state.generation,
    viewRef,
    activeFileId: activeFile?.id ?? DEFAULT_FILE_ID,
    setActiveFileId,
    following,
    setFollowing,
    presenting,
  });

  // Presenting only lasts as long as the owner stays: stop on unmount.
  useEffect(
    () => () => {
      session.publish({ presenting: undefined, following: undefined });
    },
    [session],
  );

  // The tab title follows the share title.
  useEffect(() => {
    const previous = document.title;
    document.title = meta.title ? `${meta.title} · codesh` : "codesh";
    return () => {
      document.title = previous;
    };
  }, [meta.title]);

  // Once the session has left, the gate above forgets its credentials too.
  const left = state.closed !== null;
  const rejoin = state.denied === "pin_required" || state.denied === "pending_approval";
  useEffect(() => {
    if (left) onLeft?.(rejoin);
  }, [left, rejoin, onLeft]);

  if (state.closed === "kicked") return <KickedScreen banned={bannedByEvent === true} />;
  if (state.closed === "deleted") return <NotFoundShare />;
  if (state.denied === "banned") return <KickedScreen banned />;
  if (state.denied === "not_found") return <NotFoundShare />;
  if (state.denied === "unauthorized") return <DeniedScreen />;
  if (rejoin) return <LoadingScreen />;
  // Forgotten on this device (here or in another tab), or signed out.
  if (state.closed === "left") return <Navigate to="/" replace />;
  if (!activeFile) return <LoadingScreen />;

  const value: EditorCtx = {
    session,
    doc,
    share,
    refetchShare,
    state,
    me,
    isOwner,
    readOnly: state.readOnly,
    meta,
    files,
    activeFile,
    setActiveFileId,
    participants,
    viewRef,
    info,
    panel,
    openPanel,
    closePanel,
    following,
    setFollowing,
    presenting,
    setPresenting,
    rtt,
  };
  return (
    <EditorContext.Provider value={value}>
      <EditorShell follow={follow} />
    </EditorContext.Provider>
  );
}
