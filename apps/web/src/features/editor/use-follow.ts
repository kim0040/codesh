import type { EditorView } from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import { prefersReducedMotion } from "../../lib/appearance";
import { type AwarenessPeer, useAwarenessSelector } from "../../lib/collab/hooks";
import type { DocSession } from "../../lib/collab/session";

interface FollowOptions {
  session: DocSession;
  generation: number;
  viewRef: MutableRefObject<EditorView | null>;
  activeFileId: string;
  setActiveFileId: (id: string) => void;
  /** Person I follow (client id), or null. */
  following: string | null;
  setFollowing: (clientId: string | null) => void;
  /** I am presenting myself, so I never follow anyone. */
  presenting: boolean;
}

interface FollowView {
  presenterId: string | null;
  /** The person I follow still has a tab here. */
  followingPresent: boolean;
  target: AwarenessPeer | null;
}

function readFollowView(peers: AwarenessPeer[], following: string | null): FollowView {
  const presenter = peers.find((peer) => !peer.isSelf && peer.state.presenting);
  return {
    presenterId: presenter?.user.clientId ?? null,
    followingPresent: following !== null && peers.some((p) => p.user.clientId === following),
    target: following
      ? (peers.find((peer) => !peer.isSelf && peer.user.clientId === following) ?? null)
      : null,
  };
}

/** Awareness states are replaced on every update, so the target's state compares by reference. */
function sameFollowView(a: FollowView, b: FollowView): boolean {
  return (
    a.presenterId === b.presenterId &&
    a.followingPresent === b.followingPresent &&
    a.target?.awarenessId === b.target?.awarenessId &&
    a.target?.state === b.target?.state
  );
}

export interface FollowResult {
  target: AwarenessPeer | null;
  /** Stops following; a presenter is not followed again until their next presentation. */
  stop: () => void;
}

/** Scrolls my editor to where the followed person is looking and switches to their file. */
export function useFollow(options: FollowOptions): FollowResult {
  const {
    session,
    generation,
    viewRef,
    activeFileId,
    setActiveFileId,
    following,
    setFollowing,
    presenting,
  } = options;
  // Only who presents and the followed person's state re-render this; other cursors do not.
  const { presenterId, followingPresent, target } = useAwarenessSelector(
    session.awareness,
    (peers) => readFollowView(peers, following),
    sameFollowView,
    following,
  );
  void generation;

  // A presenter is followed automatically, until I choose to stop.
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    if (presenting) return;
    if (presenterId && !dismissed.current.has(presenterId) && following === null) {
      setFollowing(presenterId);
    }
    if (!presenterId && following !== null && !followingPresent) {
      setFollowing(null);
    }
  }, [presenterId, presenting, following, setFollowing, followingPresent]);

  const viewport = target?.state.viewport;
  const targetFile = target?.state.fileId;

  useEffect(() => {
    if (!target || presenting) return;
    if (targetFile && targetFile !== activeFileId) setActiveFileId(targetFile);
  }, [target, targetFile, activeFileId, setActiveFileId, presenting]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !viewport || !targetFile || targetFile !== activeFileId) return;
    const line = view.state.doc.line(
      Math.min(Math.max(1, viewport.fromLine), view.state.doc.lines),
    );
    const top = view.lineBlockAt(line.from).top;
    view.scrollDOM.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [viewport?.fromLine, viewport?.toLine, targetFile, activeFileId, viewRef, viewport]);

  // Publish who I follow so the other person sees a follower dot.
  useEffect(() => {
    session.publish({ following: following ?? undefined });
  }, [session, following]);

  useEffect(() => {
    if (!presenterId) dismissed.current.clear();
  }, [presenterId]);

  const stop = () => {
    if (following && following === presenterId) dismissed.current.add(following);
    setFollowing(null);
  };
  return { target, stop };
}
