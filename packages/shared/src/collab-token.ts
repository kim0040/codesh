import { type CollabTokenPayload, collabTokenPayloadSchema } from "./tokens.js";

/**
 * Collab token (§8): `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, <payload part>))`.
 * Uses Web Crypto so the same code runs in Node (api, collab) and the browser bundle.
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signCollabToken(
  payload: CollabTokenPayload,
  secret: string,
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(collabTokenPayloadSchema.parse(payload))));
  const key = await hmacKey(secret, "sign");
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${toBase64Url(signature)}`;
}

/** The payload when the signature is valid and `exp` is in the future, else null. */
export async function verifyCollabToken(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CollabTokenPayload | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const signature = fromBase64Url(sig);
  const json = fromBase64Url(body);
  if (!signature || !json) return null;
  const key = await hmacKey(secret, "verify");
  // Constant-time comparison is done by subtle.verify.
  if (!(await crypto.subtle.verify("HMAC", key, signature as BufferSource, encoder.encode(body))))
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    return null;
  }
  const result = collabTokenPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp <= nowSeconds) return null;
  return result.data;
}
