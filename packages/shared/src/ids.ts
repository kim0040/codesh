import { DEFAULT_FILE_ID, JOIN_CODE_LENGTH } from "./constants.js";
import { z } from "./zod.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;

const BASE62_ID = /^[0-9A-Za-z]{8}$/;
const HAS_LETTER = /[A-Za-z]/;
const JOIN_CODE = /^[1-9][0-9]{5}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Uniform integer in [0, max) from the Web Crypto RNG, without modulo bias. */
function randomBelow(max: number): number {
  const limit = 256 - (256 % max);
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    const value = byte[0] as number;
    if (value < limit) return value % max;
  }
}

function randomString(alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet.charAt(randomBelow(alphabet.length));
  return out;
}

export function isShareId(value: string): boolean {
  return BASE62_ID.test(value) && HAS_LETTER.test(value);
}

export function isJoinCode(value: string): boolean {
  return JOIN_CODE.test(value);
}

export function isFileId(value: string): boolean {
  return value === DEFAULT_FILE_ID || BASE62_ID.test(value);
}

export function isClientId(value: string): boolean {
  return UUID_V4.test(value);
}

/** 8 chars base62 with at least one letter, so it can never be mistaken for a join code. */
export function generateShareId(): string {
  for (;;) {
    const id = randomString(BASE62, ID_LENGTH);
    if (HAS_LETTER.test(id)) return id;
  }
}

/** 6 digits, no leading zero. */
export function generateJoinCode(): string {
  return randomString("123456789", 1) + randomString("0123456789", JOIN_CODE_LENGTH - 1);
}

/** Only the first file of a share is `main`; later files get a random id. */
export function generateFileId(): string {
  return randomString(BASE62, ID_LENGTH);
}

export function generateClientId(): string {
  return crypto.randomUUID();
}

// Lab ids and codes follow the share rules (§3).
export const generateLabId = generateShareId;
export const generateLabCode = generateJoinCode;
export const isLabId = isShareId;
export const isLabCode = isJoinCode;

export const shareIdSchema = z.string().refine(isShareId, "invalid share id");
export const joinCodeSchema = z.string().refine(isJoinCode, "invalid join code");
export const fileIdSchema = z.string().refine(isFileId, "invalid file id");
export const clientIdSchema = z.string().refine(isClientId, "invalid client id");
export const labIdSchema = shareIdSchema;
export const labCodeSchema = joinCodeSchema;
export const uploadIdSchema = z.string().min(1).max(64);

export type ShareId = z.infer<typeof shareIdSchema>;
export type JoinCode = z.infer<typeof joinCodeSchema>;
export type FileId = z.infer<typeof fileIdSchema>;
export type ClientId = z.infer<typeof clientIdSchema>;
