import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { onCollabConnected } from "../app-update";

/**
 * One WebSocket per tab (docs/ARCHITECTURE.md §11). Every document of this tab, the editor and the
 * lab grid alike, is multiplexed over it. It closes a few seconds after the last holder leaves, so
 * moving between two shares reuses the connection and leaving the editors frees it.
 */

const IDLE_CLOSE_MS = 5000;

let socket: HocuspocusProviderWebsocket | null = null;
let refs = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function collabUrl(docHint: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  // `doc` is what the reverse proxy routes on (`lb_policy query doc`), so the first document of
  // the tab decides which collab instance the shared connection lands on.
  return `${scheme}://${window.location.host}/collab?doc=${encodeURIComponent(docHint)}`;
}

export function acquireSocket(docHint: string): {
  socket: HocuspocusProviderWebsocket;
  release: () => void;
} {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (!socket) {
    socket = new HocuspocusProviderWebsocket({
      url: collabUrl(docHint),
      // Retry forever with a short, capped backoff: a LAN server restart should heal in seconds.
      maxAttempts: 0,
      delay: 400,
      factor: 1.6,
      minDelay: 200,
      maxDelay: 4000,
      jitter: true,
      messageReconnectTimeout: 30_000,
    });
    // A reconnect may reach an updated server: the tab then offers a reload (lib/app-update.ts).
    socket.on("connect", onCollabConnected);
  }
  refs++;
  let released = false;
  return {
    socket,
    release: () => {
      if (released) return;
      released = true;
      refs--;
      if (refs > 0 || closeTimer) return;
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (refs > 0) return;
        socket?.destroy();
        socket = null;
      }, IDLE_CLOSE_MS);
    },
  };
}
