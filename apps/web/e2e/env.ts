/** Ports and names of the end-to-end stack; they differ from the dev stack so both can run at once. */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
export const COLLAB_PORT = Number(process.env.E2E_COLLAB_PORT ?? 3102);
export const BASE_URL = `http://localhost:${WEB_PORT}`;
export const MONGO_URL = process.env.E2E_MONGO_URL ?? "mongodb://localhost:27017/codesh_e2e";
export const VALKEY_URL = process.env.E2E_VALKEY_URL ?? "redis://localhost:6379/5";

/** Token of the admin API in the end-to-end stack (the API switches the admin console off without one). */
export const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "e2e-admin-token";
