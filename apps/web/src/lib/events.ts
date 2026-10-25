import type { NearbyItem, PresenceUser, SseEventData, SseEventType } from "@gachipad/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * One EventSource per tab (docs/ARCHITECTURE.md §9.1). It reconnects by itself; presence and
 * nearby are full lists, everything else is an event for the toast layer or a screen.
 */

type Handler<T extends SseEventType> = (data: SseEventData<T>) => void;

const EVENT_TYPES: readonly SseEventType[] = [
  "presence",
  "nearby",
  "invite",
  "broadcast",
  "approval-request",
  "approval-result",
  "kicked",
  "lab",
];

interface Snapshot {
  presence: PresenceUser[];
  nearby: NearbyItem[];
  /** False until the first list arrived. */
  ready: boolean;
  connected: boolean;
}

let source: EventSource | null = null;
let refs = 0;
let snapshot: Snapshot = { presence: [], nearby: [], ready: false, connected: false };
const listeners = new Set<() => void>();
const handlers = new Map<SseEventType, Set<(data: never) => void>>();

function setSnapshot(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function dispatch(type: SseEventType, data: unknown) {
  for (const handler of handlers.get(type) ?? []) (handler as (data: unknown) => void)(data);
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  const next = new EventSource("/api/events");
  source = next;
  next.onopen = () => setSnapshot({ connected: true });
  next.onerror = () => setSnapshot({ connected: false });
  for (const type of EVENT_TYPES) {
    next.addEventListener(type, (event) => {
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        return;
      }
      if (type === "presence") setSnapshot({ presence: data as PresenceUser[], ready: true });
      else if (type === "nearby") setSnapshot({ nearby: data as NearbyItem[], ready: true });
      dispatch(type, data);
    });
  }
}

function close() {
  source?.close();
  source = null;
  setSnapshot({ connected: false });
}

/** Keeps the stream open while at least one holder exists. */
export function retainEvents(): () => void {
  refs++;
  open();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refs--;
    if (refs === 0) close();
  };
}

export function onSseEvent<T extends SseEventType>(type: T, handler: Handler<T>): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler as (data: never) => void);
  return () => {
    set?.delete(handler as (data: never) => void);
  };
}

/** Subscribes for the lifetime of the component; always calls the latest handler. */
export function useSseEvent<T extends SseEventType>(type: T, handler: Handler<T>): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => onSseEvent(type, (data) => latest.current(data)), [type]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

export function useEventsSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePresence(): PresenceUser[] {
  return useEventsSnapshot().presence;
}

export function useNearby(): { items: NearbyItem[]; ready: boolean } {
  const { nearby, ready } = useEventsSnapshot();
  return { items: nearby, ready };
}
