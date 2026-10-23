import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/** PIN hashing (scrypt), and edit keys (§8). */

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

const SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1, keyLength: 32 };

function scrypt(secret: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      secret.normalize("NFKC"),
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$<salt>$<hash>`, base64url. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, SCRYPT);
  const { N, r, p } = SCRYPT;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(pin, Buffer.from(salt, "base64url"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keyLength: expected.length,
  });
  return timingSafeEqual(key, expected);
}

/** 144 bits of randomness, URL safe. Used for edit keys. */
export const randomKey = () => randomBytes(18).toString("base64url");

/** Compares secrets of any length without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
