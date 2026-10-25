import { SLOW_CLIENT_CLOSE_CODE } from "@gachipad/shared";

/** The parts of a `ws` socket the guard needs (Hocuspocus hands out a proxy of it). */
export interface GuardedSocket {
  send(data: never, ...rest: never[]): void;
  close(code?: number, reason?: string): void;
  /** `ws` only: drops the TCP connection without a close handshake. */
  terminate?(): void;
  readonly readyState: number;
  readonly bufferedAmount?: number;
}

const OPEN = 1;
const CLOSED = 3;
/** A peer this slow will not answer the close handshake either; ws would wait 30 s for it. */
export const SLOW_CLIENT_TERMINATE_MS = 5000;
const guarded = new WeakSet<object>();

/**
 * §6.8: once more than `limitBytes` wait in a socket's send buffer, close it with 4408. The client
 * reconnects and resyncs from the current state instead of the server queueing every update.
 * `onSend` sees the size of every message.
 */
export function guardSlowClient(
  socket: GuardedSocket,
  limitBytes: number,
  onClose?: () => void,
  onSend?: (bytes: number) => void,
) {
  if (guarded.has(socket)) return;
  guarded.add(socket);
  const send = socket.send.bind(socket) as (...args: unknown[]) => void;
  (socket as unknown as { send: (...args: unknown[]) => void }).send = (...args: unknown[]) => {
    send(...args);
    const data = args[0];
    if (onSend && data instanceof Uint8Array) onSend(data.byteLength);
    if (socket.readyState === OPEN && (socket.bufferedAmount ?? 0) > limitBytes) {
      socket.close(SLOW_CLIENT_CLOSE_CODE, "slow client");
      onClose?.();
      setTimeout(() => {
        if (socket.readyState !== CLOSED) socket.terminate?.();
      }, SLOW_CLIENT_TERMINATE_MS).unref();
    }
  };
}
