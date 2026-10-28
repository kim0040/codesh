import type { FastifyRequest } from "fastify";
import type { Ctx } from "./ctx.js";
import { cidrContains, parseIp } from "./net.js";

/**
 * Headers for API responses. Nothing here names an origin: the API serves JSON and attachments
 * only, so the CSP forbids loading anything at all.
 */
export const API_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": API_CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
} as const;

/** Forwarded HTTPS is meaningful only when the connection is from a configured proxy. */
export function requestIsHttps(ctx: Ctx, request: FastifyRequest): boolean {
  if (request.protocol === "https") return true;
  const peer = parseIp(request.ip);
  return (
    peer !== null &&
    ctx.trusted.some((cidr) => cidrContains(cidr, peer)) &&
    request.headers["x-forwarded-proto"] === "https"
  );
}
