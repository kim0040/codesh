import type { AwarenessState, Comment, UserRef } from "@codesh/shared";
import { YDOC } from "@codesh/shared";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { type DocMetaView, type FileEntry, readComments, readFiles, readMeta } from "./model";
import type { DocSession, SessionState } from "./session";

export function useSessionState(session: DocSession): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

/** Re-reads `read(doc)` whenever one of the observed shared types changes. */
function useYDerived<T>(
  doc: Y.Doc,
  read: (doc: Y.Doc) => T,
  targets: (doc: Y.Doc) => (Y.Map<unknown> | Y.Array<unknown>)[],
): T {
  const cache = useRef<{ doc: Y.Doc; value: T } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const types = targetsRef.current(doc);
      const handler = () => {
        cache.current = { doc, value: readRef.current(doc) };
        onChange();
      };
      for (const type of types) type.observeDeep(handler);
      return () => {
        for (const type of types) type.unobserveDeep(handler);
      };
    },
    [doc],
  );
  const getSnapshot = useCallback(() => {
    if (!cache.current || cache.current.doc !== doc) {
      cache.current = { doc, value: readRef.current(doc) };
    }
    return cache.current.value;
  }, [doc]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useFiles(doc: Y.Doc): FileEntry[] {
  return useYDerived(doc, readFiles, (d) => [d.getMap(YDOC.files)]);
}

export function useMeta(doc: Y.Doc): DocMetaView {
  return useYDerived(doc, readMeta, (d) => [d.getMap(YDOC.meta)]);
}

export function useComments(doc: Y.Doc): Comment[] {
  return useYDerived(doc, readComments, (d) => [d.getArray(YDOC.comments)]);
}

export interface AwarenessPeer {
  /** Yjs awareness client id (one per tab). */
  awarenessId: number;
  user: UserRef;
  state: Partial<AwarenessState> & { presenting?: boolean };
  isSelf: boolean;
}

function readPeers(awareness: Awareness): AwarenessPeer[] {
  const peers: AwarenessPeer[] = [];
  for (const [awarenessId, raw] of awareness.getStates()) {
    const state = raw as Partial<AwarenessState> & { presenting?: boolean };
    if (!state.user) continue;
    peers.push({
      awarenessId,
      user: state.user,
      state,
      isSelf: awarenessId === awareness.clientID,
    });
  }
  peers.sort((a, b) => a.awarenessId - b.awarenessId);
  return peers;
}

/**
 * A value derived from the awareness peers, read at most once per animation frame, that re-renders
 * only when `equal` says it changed. In a class of 50 the cursors change awareness hundreds of
 * times a second while the list of people changes when someone joins or leaves. `key` names what
 * else `select` depends on; a new key derives the value again.
 */
export function useAwarenessSelector<T>(
  awareness: Awareness,
  select: (peers: AwarenessPeer[]) => T,
  equal: (a: T, b: T) => boolean,
  key: unknown = null,
): T {
  const cache = useRef<{ awareness: Awareness; key: unknown; value: T } | null>(null);
  const selectRef = useRef(select);
  selectRef.current = select;
  const equalRef = useRef(equal);
  equalRef.current = equal;
  const subscribe = useCallback(
    (onChange: () => void) => {
      let frame = 0;
      const handler = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const value = selectRef.current(readPeers(awareness));
          const previous = cache.current;
          const same = previous?.awareness === awareness && previous.key === key;
          if (same && equalRef.current(previous.value, value)) return;
          cache.current = { awareness, key, value };
          onChange();
        });
      };
      awareness.on("change", handler);
      return () => {
        awareness.off("change", handler);
        if (frame) cancelAnimationFrame(frame);
      };
    },
    [awareness, key],
  );
  const getSnapshot = useCallback(() => {
    const cached = cache.current;
    if (!cached || cached.awareness !== awareness || cached.key !== key) {
      cache.current = { awareness, key, value: selectRef.current(readPeers(awareness)) };
    }
    return (cache.current as { value: T }).value;
  }, [awareness, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface Participant {
  clientId: string;
  name: string;
  color: string;
  isSelf: boolean;
  fileId?: string;
  presenting: boolean;
  following?: string;
  /** Awareness ids of this person's tabs. */
  awarenessIds: number[];
}

function readParticipants(peers: AwarenessPeer[]): Participant[] {
  const byClient = new Map<string, Participant>();
  for (const peer of peers) {
    const existing = byClient.get(peer.user.clientId);
    if (existing) {
      existing.awarenessIds.push(peer.awarenessId);
      existing.isSelf ||= peer.isSelf;
      continue;
    }
    byClient.set(peer.user.clientId, {
      clientId: peer.user.clientId,
      name: peer.user.name,
      color: peer.user.color,
      isSelf: peer.isSelf,
      fileId: peer.state.fileId,
      presenting: peer.state.presenting === true,
      following: peer.state.following,
      awarenessIds: [peer.awarenessId],
    });
  }
  return [...byClient.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

function sameParticipant(a: Participant, b: Participant): boolean {
  return (
    a.clientId === b.clientId &&
    a.name === b.name &&
    a.color === b.color &&
    a.isSelf === b.isSelf &&
    a.fileId === b.fileId &&
    a.presenting === b.presenting &&
    a.following === b.following &&
    a.awarenessIds.length === b.awarenessIds.length &&
    a.awarenessIds.every((id, i) => id === b.awarenessIds[i])
  );
}

function sameParticipants(a: Participant[], b: Participant[]): boolean {
  return a.length === b.length && a.every((p, i) => sameParticipant(p, b[i] as Participant));
}

/**
 * One entry per person (two tabs of the same person count once), you first. Cursor moves leave
 * it unchanged, so the people list and the editor context do not re-render for them.
 */
export function useParticipants(awareness: Awareness): Participant[] {
  return useAwarenessSelector(awareness, readParticipants, sameParticipants);
}
