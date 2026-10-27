/** Longest wait for one database operation of the copy, so a stalled server fails the copy. */
export const OPERATION_TIMEOUT_MS = 2 * 60_000;

export class OperationTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
  constructor() {
    super("Database operation timed out");
    this.name = "OperationTimeoutError";
  }
}

/** Rejects with OperationTimeoutError when `work` has not settled in time; `work` is not stopped. */
export function withTimeout<T>(work: Promise<T>, ms = OPERATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
