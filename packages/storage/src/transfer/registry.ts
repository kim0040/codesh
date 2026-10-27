import type { Stores } from "../types.js";
import type { TransferBackend } from "./types.js";

const backends = new WeakMap<Stores, TransferBackend>();

export function registerTransferBackend(stores: Stores, backend: TransferBackend): Stores {
  backends.set(stores, backend);
  return stores;
}

export function transferBackend(stores: Stores): TransferBackend {
  const backend = backends.get(stores);
  if (!backend) throw new Error("Storage transfer is not available for this backend");
  return backend;
}
