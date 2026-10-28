import {
  apiKeys,
  generateClientId,
  isClientId,
  keys,
  LEGACY_SESSION_COOKIE,
  PRESENCE_USER_TTL_SECONDS,
  SESSION_COOKIE,
} from "@gachipad/shared";
import "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "./ctx.js";
import { cidrContains, parseIp, resolveClientIp, resolveNet } from "./net.js";
import { requireCapacity } from "./quotas.js";

export interface Identity {
  provider: string;
  subject: string;
  name?: string;
  email?: string;
}

export interface Session {
  clientId: string;
  name: string | null;
  color: string;
  ip: string;
  net: string;
  room: string | null;
  identity: Identity | null;
}

declare module "fastify" {
  interface FastifyRequest {
    session: Session;
  }
}

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;
const PROFILE_TTL_SECONDS = 30 * 24 * 3600;
const PALETTE = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0284c7",
  "#4f46e5",
  "#9333ea",
  "#c026d3",
  "#be123c",
  "#65a30d",
  "#0e7490",
];

export const defaultColor = (clientId: string) =>
  PALETTE[Number.parseInt(clientId.slice(0, 8), 16) % PALETTE.length] as string;

export const guestName = (clientId: string) => `Guest-${clientId.slice(0, 4)}`;

/** The client address after applying the trusted-proxy rules of §7. */
export function clientIp(ctx: Ctx, request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const resolved = resolveClientIp(
    request.ip,
    typeof forwarded === "string" ? forwarded : undefined,
    ctx.trusted,
  );
  const bytes = parseIp(resolved);
  if (
    ctx.config.network === "public" &&
    (!bytes || ctx.trusted.some((cidr) => cidrContains(cidr, bytes)))
  ) {
    if (Date.now() - ctx.unknownClientWarningAt >= 60_000) {
      ctx.unknownClientWarningAt = Date.now();
      request.log.warn(
        "Public client identity is unknown: check Docker userland-proxy/IPv6 port bindings and the TLS proxy X-Forwarded-For chain",
      );
    }
    return "unknown";
  }
  return resolved;
}

/** Starts a session for the browser: a new client id in the signed `gachipad_sid` cookie. */
export function issueSession(ctx: Ctx, reply: FastifyReply): string {
  const clientId = generateClientId();
  setSessionCookie(ctx, reply, clientId);
  return clientId;
}

function setSessionCookie(ctx: Ctx, reply: FastifyReply, clientId: string): void {
  reply.setCookie(SESSION_COOKIE, clientId, {
    signed: true,
    httpOnly: true,
    secure: ctx.config.publicUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function loadSession(
  ctx: Ctx,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Session> {
  let clientId: string | null = null;
  // legacy codesh name (1.0.x); remove in 2.0
  for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const raw = request.cookies[name];
    if (!raw) continue;
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value && isClientId(unsigned.value)) {
      clientId = unsigned.value;
      if (name === LEGACY_SESSION_COOKIE) setSessionCookie(ctx, reply, clientId);
      break;
    }
  }
  if (!clientId) clientId = issueSession(ctx, reply);
  const settings = await ctx.settings();
  const ip = clientIp(ctx, request);
  const group = resolveNet(ip, settings);
  // An internet /24 or shared NAT is not a trusted neighbourhood. Only operator-defined rooms
  // opt into shared discovery; otherwise public presence, previews and broadcasts stay private.
  const room = group.room;
  const net = ctx.config.network === "public" && room === null ? `client:${clientId}` : group.net;
  const [profile, identity] = await Promise.all([
    ctx.valkey.hgetall(apiKeys.profile(clientId)),
    ctx.valkey.hgetall(apiKeys.identity(clientId)),
  ]);
  return {
    clientId,
    name: profile.name || null,
    color: profile.color || defaultColor(clientId),
    ip,
    net,
    room,
    identity: identity.subject
      ? {
          provider: identity.provider ?? "",
          subject: identity.subject,
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.email ? { email: identity.email } : {}),
        }
      : null,
  };
}

export async function saveProfile(
  ctx: Ctx,
  clientId: string,
  profile: { name?: string; color?: string },
): Promise<void> {
  await requireCapacity(ctx);
  const fields = Object.entries(profile).filter(([, v]) => v !== undefined) as [string, string][];
  if (fields.length === 0) return;
  const key = apiKeys.profile(clientId);
  await ctx.valkey.hset(key, Object.fromEntries(fields));
  await ctx.valkey.expire(key, PROFILE_TTL_SECONDS);
  // Keep an existing presence card in step so other users see the change at once.
  const card = keys.presenceUser(clientId);
  if (await ctx.valkey.exists(card)) {
    await ctx.valkey.hset(card, Object.fromEntries(fields));
    await ctx.valkey.expire(card, PRESENCE_USER_TTL_SECONDS);
  }
}

/** Display name for tokens and events: the chosen name, else a stable guest name. */
export const displayName = (s: Pick<Session, "name" | "clientId">) =>
  s.name ?? guestName(s.clientId);

export const userRef = (s: Session) => ({
  clientId: s.clientId,
  name: displayName(s),
  color: s.color,
});
