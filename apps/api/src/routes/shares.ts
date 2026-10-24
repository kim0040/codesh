import {
  type Access,
  apiKeys,
  createShareBodySchema,
  createShareResponseSchema,
  downloadQuerySchema,
  forkShareResponseSchema,
  getShareResponseSchema,
  joinPendingResponseSchema,
  joinShareBodySchema,
  joinShareResponseSchema,
  keys,
  listSharesResponseSchema,
  okResponseSchema,
  patchShareBodySchema,
  type ShareListItem,
  shareParamsSchema,
} from "@codesh/shared";
import type { ShareUpdate } from "@codesh/storage";
import { strToU8, zipSync } from "fflate";
import type { z } from "zod";
import {
  accessOf,
  checkPin,
  findShare,
  mintToken,
  noteActivity,
  PENDING_TTL_SECONDS,
  recordGrant,
  requireOwner,
  requireParticipant,
  shareView,
} from "../access.js";
import { hashPin, randomKey, safeEqual } from "../crypto.js";
import type { Ctx } from "../ctx.js";
import { loadDoc, readContent, sendCommand, sharePreview } from "../docs.js";
import { ApiError, forbidden, invalid, notFound } from "../errors.js";
import { attachment, basename, sanitizePath } from "../files.js";
import { addressKey } from "../net.js";
import { announceShare, removeNearby } from "../presence.js";
import { rateLimit } from "../rate.js";
import { displayName } from "../session.js";
import { createShare, deleteShare, syncExpiry } from "../shares.js";
import { type App, limited, mapLimit, OK } from "./types.js";

const LIST_LIMIT = 100;
/**
 * A share may hold `settings.maxDocBytes` of text (5 MB by default) and JSON escaping adds to
 * that, so the 1 MiB default of Fastify would refuse legitimate pastes. The settings check
 * decides what is too large.
 */
const CREATE_BODY_LIMIT = 32 * 1024 * 1024;

/** The PATCH body for the audit log: the PIN itself is never stored, only whether one was set. */
function auditDetail(body: z.infer<typeof patchShareBodySchema>) {
  if (!body.access) return body;
  const { pin, ...access } = body.access;
  return { ...body, access: { ...access, ...(pin === undefined ? {} : { hasPin: pin !== null }) } };
}

export function shareRoutes(app: App, ctx: Ctx): void {
  const create = limited(ctx, "create", ctx.config.rateLimit.createPerMinute);

  app.post(
    "/api/shares",
    {
      preHandler: create,
      bodyLimit: CREATE_BODY_LIMIT,
      schema: { body: createShareBodySchema, response: { 200: createShareResponseSchema } },
    },
    async (request) => {
      const { body, session } = request;
      const seen = new Set<string>();
      const files = (body.files ?? []).map((file) => {
        const path = sanitizePath(file.path);
        if (path === null) throw invalid(`Invalid file path: ${file.path}`);
        if (seen.has(path)) throw invalid(`Duplicate file path: ${path}`);
        seen.add(path);
        return { path, language: file.language, content: file.content };
      });
      const { response } = await createShare(ctx, {
        ownerId: session.clientId,
        ip: session.ip,
        title: body.title ?? "",
        language: body.language,
        files,
        net: session.net,
      });
      await ctx.audit(request, "share.create", response.id);
      return response;
    },
  );

  app.get(
    "/api/shares",
    { schema: { response: { 200: listSharesResponseSchema } } },
    async (request) => {
      const { session } = request;
      const { clientId } = session;
      const now = Date.now();
      const shares = (await ctx.stores.shares.listForClient(clientId))
        .filter((share) => !share.expiresAt || share.expiresAt.getTime() > now)
        .slice(0, LIST_LIMIT);
      const labels = new Map(
        (await ctx.stores.labels.listForClient(clientId)).map((entry) => [entry.shareId, entry]),
      );
      const items = await mapLimit(shares, 8, async (share): Promise<ShareListItem | null> => {
        const owner = share.ownerId === clientId;
        // A saved entry must not outlive the access: banned clients lose the share from the list,
        // and clients who now need a PIN or approval see neither title nor code until admitted.
        let hidden = false;
        if (!owner) {
          try {
            const access = await accessOf(ctx, share, session);
            hidden = access.needsPin || access.needsApproval;
          } catch (error) {
            if (error instanceof ApiError && error.code === "banned") return null;
            throw error;
          }
        }
        return {
          id: share.id,
          title: hidden ? "" : share.title,
          language: hidden ? "" : share.language,
          role: owner ? "owner" : share.access.default,
          saved: share.savedBy.includes(clientId),
          updatedAt: share.updatedAt.toISOString(),
          expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
          preview: hidden ? "" : await sharePreview(ctx, share).catch(() => ""),
          folder: labels.get(share.id)?.folder ?? null,
          tags: labels.get(share.id)?.tags ?? [],
        };
      });
      return items.filter((item) => item !== null);
    },
  );

  app.get(
    "/api/shares/:id",
    { schema: { params: shareParamsSchema, response: { 200: getShareResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      const access = await accessOf(ctx, share, request.session);
      return shareView(share, request.session, access);
    },
  );

  app.post(
    "/api/shares/:id/join",
    {
      schema: {
        params: shareParamsSchema,
        body: joinShareBodySchema,
        response: { 200: joinShareResponseSchema, 202: joinPendingResponseSchema },
      },
    },
    async (request, reply) => {
      const { session, body } = request;
      const share = await findShare(ctx, request.params.id);
      const before = await accessOf(ctx, share, session, body.editKey);
      const keyValid = !!body.editKey && safeEqual(body.editKey, share.access.editKey);
      if (!before.granted) {
        // A client waiting for approval has already passed the PIN check.
        if (share.access.pinHash !== null && !before.pending) {
          await checkPin(ctx, share, session, body.pin);
        }
        if (share.access.requireApproval) {
          const pendingKey = keys.pending(share.id);
          const added = Number(
            await ctx.valkey.eval(
              ADD_PENDING,
              1,
              pendingKey,
              session.clientId,
              displayName(session),
              ctx.config.limits.PENDING_MAX_PER_SHARE,
              PENDING_TTL_SECONDS,
            ),
          );
          if (added === -1)
            throw new ApiError("rate_limited", "The waiting room is full", { "Retry-After": "60" });
          let notify = added === 1;
          if (notify) {
            try {
              await rateLimit(ctx, session.ip, `approval:${share.id}`, 10);
              await rateLimit(ctx, "share", `approval:${share.id}`, 20);
            } catch (error) {
              if (!(error instanceof ApiError) || error.code !== "rate_limited") throw error;
              notify = false;
            }
          }
          if (notify) {
            await ctx.publishUser(share.ownerId, {
              event: "approval-request",
              data: { shareId: share.id, clientId: session.clientId, name: displayName(session) },
            });
          }
          return reply.code(202).send({ status: "pending" as const });
        }
      }
      if ((!before.granted && share.access.pinHash !== null) || keyValid) {
        await recordGrant(ctx, share, session.clientId, body.editKey);
      }
      if (before.pending) await ctx.valkey.hdel(keys.pending(share.id), session.clientId);
      const access = await accessOf(ctx, share, session, body.editKey);
      const role = access.role;
      if (role === null) throw forbidden("Not admitted");
      await ctx.valkey.hset(
        apiKeys.admittedNetworks(share.id),
        session.clientId,
        addressKey(session.ip),
      );
      await ctx.valkey.expire(apiKeys.admittedNetworks(share.id), 30 * 24 * 3600);
      await noteActivity(ctx, share);
      await ctx.audit(request, "share.join", share.id);
      return { token: await mintToken(ctx, share, session, access), role };
    },
  );

  app.patch(
    "/api/shares/:id",
    {
      schema: {
        params: shareParamsSchema,
        body: patchShareBodySchema,
        response: { 200: getShareResponseSchema },
      },
    },
    async (request) => {
      const { session, body } = request;
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, session);
      if (body.locked !== undefined && share.labId) {
        throw forbidden("A lab share is locked and unlocked by the teacher");
      }
      const settings = await ctx.settings();

      const patch: ShareUpdate = { updatedAt: new Date() };
      if (body.title !== undefined) patch.title = body.title;
      if (body.language !== undefined) patch.language = body.language;
      let askRejoin = false;
      let clearGrants = false;
      if (body.access) {
        const wanted = body.access;
        // Only the fields that change are written (as dotted paths), so a concurrent PATCH of
        // another access field, or of the same one, is not undone by this one.
        const next: Partial<Access> = {};
        if (wanted.default !== undefined && wanted.default !== share.access.default) {
          next.default = wanted.default;
          askRejoin = true;
        }
        if (wanted.pin !== undefined) {
          next.pinHash = wanted.pin === null ? null : await hashPin(wanted.pin);
          if (wanted.pin !== null) {
            // Everyone admitted with the old PIN has to enter the new one.
            clearGrants = true;
            askRejoin = true;
          }
        }
        if (wanted.requireApproval !== undefined) {
          next.requireApproval = wanted.requireApproval;
          if (wanted.requireApproval && !share.access.requireApproval) {
            clearGrants = true;
            askRejoin = true;
          }
        }
        if (wanted.nearby !== undefined) next.nearby = wanted.nearby;
        if (wanted.rotateEditKey) {
          next.editKey = randomKey();
          askRejoin = true;
        }
        // A nearby card shows code; a protected share must not.
        const pinHash = next.pinHash === undefined ? share.access.pinHash : next.pinHash;
        const approval = next.requireApproval ?? share.access.requireApproval;
        if (pinHash !== null || approval) next.nearby = false;
        if (askRejoin) next.generation = randomKey();
        patch.access = next;
      }
      if (body.locked !== undefined && body.locked !== share.locked) patch.locked = body.locked;

      // Title and language live in the document too; collab writes them (§6.11), so a refusal or
      // an unreachable collab leaves the share untouched.
      if (body.title !== undefined || body.language !== undefined) {
        if (share.labId && (await accessOf(ctx, share, session)).role === "view")
          throw forbidden("A locked lab share is read-only");
        await sendCommand(ctx, share.id, {
          kind: "meta",
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
        });
      }

      let updated = await ctx.stores.shares.update(share.id, patch);
      if (!updated) throw notFound("Share not found");
      if (
        updated.access.nearby &&
        (updated.access.pinHash !== null || updated.access.requireApproval)
      ) {
        // A concurrent PATCH turned on a PIN or approval after we read the share.
        updated =
          (await ctx.stores.shares.update(share.id, { access: { nearby: false } })) ?? updated;
      }

      if (body.saved === true) {
        updated = (await ctx.stores.shares.addSaved(share.id, session.clientId)) ?? updated;
      } else if (body.saved === false) {
        const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
        updated =
          (await ctx.stores.shares.removeSaved(share.id, session.clientId, expiresAt)) ?? updated;
      }
      if (body.saved !== undefined) await syncExpiry(ctx, updated);

      if (clearGrants) {
        // A client that queued under the old PIN must enter the new one as well.
        await ctx.valkey.del(apiKeys.grants(share.id), keys.pending(share.id));
      }
      // A new PIN starts a new guessing window, so the owner can undo a lockout of the share.
      if (body.access?.pin) await ctx.valkey.del(apiKeys.pinFailsShare(share.id));
      if (patch.locked !== undefined) await ctx.publishPerm(share.id, "lock");
      if (askRejoin) await ctx.publishPerm(share.id, "role");
      if (updated.access.nearby && !share.access.nearby) {
        await announceShare(ctx, updated, session.net, await sharePreview(ctx, updated));
      } else if (!updated.access.nearby && share.access.nearby) {
        await removeNearby(ctx, share.id);
      }
      await ctx.audit(request, "share.update", share.id, auditDetail(body));
      return shareView(updated, session, await accessOf(ctx, updated, session));
    },
  );

  app.delete(
    "/api/shares/:id",
    { schema: { params: shareParamsSchema, response: { 200: okResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      requireOwner(share, request.session);
      await deleteShare(ctx, share);
      await ctx.audit(request, "share.delete", share.id);
      return OK;
    },
  );

  app.post(
    "/api/shares/:id/save",
    { schema: { params: shareParamsSchema, response: { 200: okResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      await requireParticipant(ctx, share, request.session);
      const saved = await ctx.stores.shares.addSaved(share.id, request.session.clientId);
      if (saved) await syncExpiry(ctx, saved);
      return OK;
    },
  );

  app.delete(
    "/api/shares/:id/save",
    { schema: { params: shareParamsSchema, response: { 200: okResponseSchema } } },
    async (request) => {
      const share = await findShare(ctx, request.params.id);
      await requireParticipant(ctx, share, request.session);
      const settings = await ctx.settings();
      const expiresAt = new Date(Date.now() + settings.anonymousTtlHours * 3600 * 1000);
      const unsaved = await ctx.stores.shares.removeSaved(
        share.id,
        request.session.clientId,
        expiresAt,
      );
      if (unsaved) await syncExpiry(ctx, unsaved);
      // The share leaves "my shares" unless it is the person's own, and their labels go with it.
      if (share.ownerId !== request.session.clientId) {
        await ctx.stores.labels.delete(request.session.clientId, share.id);
      }
      return OK;
    },
  );

  app.post(
    "/api/shares/:id/fork",
    {
      preHandler: create,
      schema: { params: shareParamsSchema, response: { 200: forkShareResponseSchema } },
    },
    async (request) => {
      const { session } = request;
      const share = await findShare(ctx, request.params.id);
      await requireParticipant(ctx, share, session);
      const content = readContent(await loadDoc(ctx, share.id));
      const { response } = await createShare(ctx, {
        ownerId: session.clientId,
        ip: session.ip,
        title: content.title || share.title,
        language: content.language || share.language,
        files: content.files.map((file) => ({
          path: file.path,
          language: file.language,
          content: file.content,
        })),
        forkOf: share.id,
        net: session.net,
      });
      await ctx.audit(request, "share.fork", share.id, { fork: response.id });
      return response;
    },
  );

  app.get(
    "/api/shares/:id/download",
    { schema: { params: shareParamsSchema, querystring: downloadQuerySchema } },
    async (request, reply) => {
      const share = await findShare(ctx, request.params.id);
      await requireParticipant(ctx, share, request.session);
      const content = readContent(await loadDoc(ctx, share.id));
      await ctx.audit(request, "share.download", share.id, { file: request.query.file ?? null });

      const wanted = request.query.file;
      if (wanted !== undefined) {
        const file = content.files.find((candidate) => candidate.id === wanted);
        if (!file) throw notFound("File not found");
        return reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("Content-Disposition", attachment(basename(file.path)))
          .send(file.content);
      }

      const entries: Record<string, Uint8Array> = {};
      for (const file of content.files) {
        let name = sanitizePath(file.path) ?? file.id;
        // Two files can end up with the same path after sanitising; keep both.
        if (name in entries) name = `${file.id}/${name}`;
        entries[name] = strToU8(file.content);
      }
      const stem = sanitizePath(content.title || share.title) ?? share.id;
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", attachment(`${basename(stem)}.zip`))
        .send(Buffer.from(zipSync(entries)));
    },
  );
}

const ADD_PENDING = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;
