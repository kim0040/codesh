import { DEFAULT_FILE_ID, type UserRef, YDOC } from "@codesh/shared";
import { useEffect, useRef, useState } from "react";
import { useAwarenessPeers, useSessionState } from "../../lib/collab/hooks";
import { DocSession, type SessionState } from "../../lib/collab/session";

export interface Preview {
  state: SessionState;
  text: string;
  /** Someone other than me is connected to this document. */
  online: boolean;
  /** Time of the last change seen since this preview opened, or null. */
  changedAt: number | null;
}

const THROTTLE_MS = 400;
const SETTLE_MS = 1500;

/** A session for a read-only live view; it closes when the component unmounts. */
export function usePreviewSession(shareId: string, me: UserRef): DocSession | null {
  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const next = new DocSession({ shareId, user: me, role: "view", credentials: {} });
    setSession(next);
    return () => {
      next.destroy();
      setSession(null);
    };
  }, [shareId, me]);
  return session;
}

/** Text of the main file (throttled), connection state and whether anyone else is there. */
export function usePreview(session: DocSession): Preview {
  const state = useSessionState(session);
  const peers = useAwarenessPeers(session.awareness);
  const [text, setText] = useState("");
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const settled = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebind when the document is replaced
  useEffect(() => {
    settled.current = false;
    const ytext = session.doc.getText(YDOC.fileText(DEFAULT_FILE_ID));
    let timer = 0;
    const read = () => {
      timer = 0;
      setText(ytext.toString());
    };
    const onChange = () => {
      if (settled.current) setChangedAt(Date.now());
      if (!timer) timer = window.setTimeout(read, THROTTLE_MS);
    };
    ytext.observe(onChange);
    read();
    // Changes that arrive while the first sync is still running are history, not live edits.
    const settle = window.setTimeout(() => {
      settled.current = true;
    }, SETTLE_MS);
    return () => {
      ytext.unobserve(onChange);
      window.clearTimeout(timer);
      window.clearTimeout(settle);
    };
  }, [session, state.generation]);

  return { state, text, online: peers.some((peer) => !peer.isSelf), changedAt };
}
