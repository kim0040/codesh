import { DEFAULT_FILE_ID, type UserRef, YDOC } from "@codesh/shared";
import { useEffect, useRef, useState } from "react";
import { useAwarenessSelector, useSessionState } from "../../lib/collab/hooks";
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

/** A session for a read-only live view, never kept offline; it closes when the component unmounts. */
export function usePreviewSession(shareId: string, me: UserRef): DocSession | null {
  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const next = new DocSession({
      shareId,
      user: me,
      role: "view",
      credentials: {},
      keepCopy: false,
    });
    setSession(next);
    return () => {
      next.destroy();
      setSession(null);
    };
  }, [shareId, me]);
  return session;
}

const someoneElse = (peers: { isSelf: boolean }[]) => peers.some((peer) => !peer.isSelf);

/**
 * Text of the main file and the time of the last change (both throttled), connection state and
 * whether anyone else is there. A teacher's grid holds 50 of these, so a keystroke or a cursor
 * move of a student must not re-render a tile by itself.
 */
export function usePreview(session: DocSession): Preview {
  const state = useSessionState(session);
  const online = useAwarenessSelector(session.awareness, someoneElse, Object.is);
  const [text, setText] = useState("");
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const settled = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebind when the document is replaced
  useEffect(() => {
    settled.current = false;
    const ytext = session.doc.getText(YDOC.fileText(DEFAULT_FILE_ID));
    let timer = 0;
    let lastChange: number | null = null;
    const read = () => {
      timer = 0;
      setText(ytext.toString());
      if (lastChange !== null) setChangedAt(lastChange);
    };
    const onChange = () => {
      if (settled.current) lastChange = Date.now();
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

  return { state, text, online, changedAt };
}
