import { randomUUID } from "node:crypto";
import {
  apiKeys,
  createLabBodySchema,
  createLabResponseSchema,
  distributeLabResponseSchema,
  type GetLabResponse,
  generateLabId,
  getLabResponseSchema,
  joinLabBodySchema,
  joinLabResponseSchema,
  type LabRecord,
  labParamsSchema,
  patchLabBodySchema,
  type ShareRecord,
} from "@codesh/shared";
import { findShare, requireOwner } from "../access.js";
import { allocateCode } from "../codes.js";
import type { Ctx } from "../ctx.js";
import { type DocContent, loadDoc, readContent } from "../docs.js";
import { ApiError, forbidden, invalid, notFound } from "../errors.js";
import { removeNearby } from "../presence.js";
import { saveProfile } from "../session.js";
import { createShare, urlOf } from "../shares.js";
import { type App, limited, mapLimit } from "./types.js";

const JOIN_LOCK_SECONDS = 30;
const JOIN_WAIT_MS = 3000;
const DISTRIBUTE_LOCK_SECONDS = 300;

/** Deletes the lock only while it is still ours: after its TTL another request may hold it. */
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

async function findLab(ctx: Ctx, id: string): Promise<LabRecord> {
  const lab = await ctx.stores.labs.get(id);
  if (!lab) throw notFound("Lab not found");
  if (lab.expiresAt.getTime() <= Date.now()) throw new ApiError("expired", "This lab has expired");
  return lab;
}

function labView(lab: LabRecord, clientId: string): GetLabResponse {
  const teacher = lab.ownerId === clientId;
  return {
    id: lab.id,
    title: lab.title,
    joinCode: lab.joinCode,
    // The template is a normal share the teacher owns: its id would let a student join it.
    templateShareId: teacher ? lab.templateShareId : null,
    locked: lab.locked,
    role: teacher ? "teacher" : "student",
    // A student sees only their own entry; the grid of everyone's code is the teacher's.
    students: lab.students
      .filter((student) => teacher || student.clientId === clientId)
      .map((student) => ({
        clientId: student.clientId,
        name: student.name,
        shareId: student.shareId,
        joinedAt: student.joinedAt.toISOString(),
      })),
    createdAt: lab.createdAt.toISOString(),
    expiresAt: lab.expiresAt.toISOString(),
  };
}

function requireTeacher(lab: LabRecord, clientId: string): void {
  if (lab.ownerId !== clientId) throw forbidden("Only the teacher can do this");
}

export function labRoutes(app: App, ctx: Ctx): void {
  /** Content of the template, or null when the lab has none. */
  const templateContent = async (lab: LabRecord): Promise<DocContent | null> => {
    if (!lab.templateShareId) return null;
    const template = await ctx.stores.shares.get(lab.templateShareId);
    if (!template) return null;
    return readContent(await loadDoc(ctx, template.id));
  };

  const acquire = async (key: string, seconds: number): Promise<string | null> => {
    const token = randomUUID();
    return (await ctx.valkey.set(key, token, "EX", seconds, "NX")) === "OK" ? token : null;
  };
  const release = (key: string, token: string) => ctx.valkey.eval(RELEASE_LOCK, 1, key, token);

  /**
   * A template is the teacher's own share; nobody else is to find it. It is taken out of the
   * nearby list so students on the same network do not see it there.
   */
  const hideTemplate = async (templateShareId: string) => {
    await ctx.stores.shares.update(templateShareId, { access: { nearby: false } });
    await removeNearby(ctx, templateShareId);
  };

  /**
   * Brings a new copy in step with the lab's current lock. The teacher may have (un)locked the lab
   * between our read of it and `addStudent`, and that PATCH did not see the copy yet.
   */
  const alignLock = async (copy: ShareRecord, lab: LabRecord | null) => {
    if (!lab || lab.locked === copy.locked) return;
    await ctx.stores.shares.update(copy.id, { locked: lab.locked });
    await ctx.publishPerm(copy.id, "lock");
  };

  /** Each student works on a copy they own; the teacher edits it as controller of the lab. */
  const forkForStudent = async (
    lab: LabRecord,
    clientId: string,
    content: DocContent | null,
    ip: string,
  ) =>
    createShare(ctx, {
      ownerId: clientId,
      ip,
      title: content?.title || lab.title,
      language: content?.language,
      files: (content?.files ?? []).map((file) => ({
        path: file.path,
        language: file.language,
        content: file.content,
      })),
      labId: lab.id,
      forkOf: lab.templateShareId ?? undefined,
      access: { default: "view", nearby: false },
      locked: lab.locked,
    });

  app.post(
    "/api/labs",
    {
      preHandler: limited(ctx, "create", ctx.config.rateLimit.createPerMinute),
      schema: { body: createLabBodySchema, response: { 200: createLabResponseSchema } },
    },
    async (request) => {
      const { session, body } = request;
      if (body.templateShareId) {
        requireOwner(await findShare(ctx, body.templateShareId), session);
      }
      const settings = await ctx.settings();
      const ttlSeconds = Math.round(settings.anonymousTtlHours * 3600);
      let id = generateLabId();
      while (await ctx.stores.labs.get(id)) id = generateLabId();
      const code = await allocateCode(ctx, "lab", id, ttlSeconds);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      await ctx.stores.labs.create({
        id,
        title: body.title ?? "",
        ownerId: session.clientId,
        joinCode: code,
        templateShareId: body.templateShareId ?? null,
        locked: false,
        students: [],
        createdAt: now,
        expiresAt,
      });
      await ctx.valkey.zadd(apiKeys.labsIndex, expiresAt.getTime(), id);
      if (body.templateShareId) await hideTemplate(body.templateShareId);
      await ctx.audit(request, "lab.create", undefined, { labId: id });
      return { id, code, url: urlOf(ctx, `lab/${id}`) };
    },
  );

  app.get(
    "/api/labs/:id",
    { schema: { params: labParamsSchema, response: { 200: getLabResponseSchema } } },
    async (request) => labView(await findLab(ctx, request.params.id), request.session.clientId),
  );

  app.post(
    "/api/labs/:id/join",
    {
      preHandler: limited(ctx, "create", ctx.config.rateLimit.createPerMinute),
      schema: {
        params: labParamsSchema,
        body: joinLabBodySchema,
        response: { 200: joinLabResponseSchema },
      },
    },
    async (request) => {
      const { session, body } = request;
      const lab = await findLab(ctx, request.params.id);
      if (lab.ownerId === session.clientId)
        throw forbidden("The teacher cannot join their own lab");
      const mine = (l: LabRecord) => l.students.find((s) => s.clientId === session.clientId);
      const joined = mine(lab);
      if (joined) return { shareId: joined.shareId };

      // A double click must not create two copies.
      const lockKey = apiKeys.labJoinLock(lab.id, session.clientId);
      const lockToken = await acquire(lockKey, JOIN_LOCK_SECONDS);
      if (lockToken === null) {
        const until = Date.now() + JOIN_WAIT_MS;
        while (Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const fresh = mine(await findLab(ctx, lab.id));
          if (fresh) return { shareId: fresh.shareId };
        }
        throw new ApiError("rate_limited", "A join is already in progress", { "Retry-After": "1" });
      }
      try {
        // The first request may have finished between our check and our lock.
        const current = await findLab(ctx, lab.id);
        const already = mine(current);
        if (already) return { shareId: already.shareId };
        await saveProfile(ctx, session.clientId, { name: body.name });
        const { share } = await forkForStudent(
          current,
          session.clientId,
          await templateContent(current),
          session.ip,
        );
        const withStudent = await ctx.stores.labs.addStudent(lab.id, {
          clientId: session.clientId,
          name: body.name,
          shareId: share.id,
          joinedAt: new Date(),
        });
        await alignLock(share, withStudent);
        await ctx.publishUser(lab.ownerId, {
          event: "lab",
          data: { labId: lab.id, kind: "joined" },
        });
        await ctx.audit(request, "lab.join", share.id, { labId: lab.id });
        return { shareId: share.id };
      } finally {
        await release(lockKey, lockToken);
      }
    },
  );

  app.patch(
    "/api/labs/:id",
    {
      schema: {
        params: labParamsSchema,
        body: patchLabBodySchema,
        response: { 200: getLabResponseSchema },
      },
    },
    async (request) => {
      const { session, body } = request;
      const lab = await findLab(ctx, request.params.id);
      requireTeacher(lab, session.clientId);
      if (body.templateShareId) {
        requireOwner(await findShare(ctx, body.templateShareId), session);
      }
      const updated = await ctx.stores.labs.update(lab.id, {
        ...(body.locked === undefined ? {} : { locked: body.locked }),
        ...(body.templateShareId === undefined ? {} : { templateShareId: body.templateShareId }),
      });
      if (!updated) throw notFound("Lab not found");
      if (body.templateShareId) await hideTemplate(body.templateShareId);

      if (body.locked !== undefined && body.locked !== lab.locked) {
        const kind = body.locked ? "locked" : "unlocked";
        await mapLimit(updated.students, 8, async (student) => {
          await ctx.stores.shares.update(student.shareId, { locked: body.locked });
          await ctx.publishPerm(student.shareId, "lock");
          await ctx.publishUser(student.clientId, { event: "lab", data: { labId: lab.id, kind } });
        });
      }
      await ctx.audit(request, "lab.update", undefined, { labId: lab.id, ...body });
      return labView(updated, session.clientId);
    },
  );

  app.post(
    "/api/labs/:id/distribute",
    { schema: { params: labParamsSchema, response: { 200: distributeLabResponseSchema } } },
    async (request) => {
      const { session } = request;
      const found = await findLab(ctx, request.params.id);
      requireTeacher(found, session.clientId);

      // One distribute at a time: a second one would fork everyone again and orphan the first copies.
      const lockKey = apiKeys.labDistributeLock(found.id);
      const lockToken = await acquire(lockKey, DISTRIBUTE_LOCK_SECONDS);
      if (lockToken === null) {
        throw new ApiError("rate_limited", "A distribution is already in progress", {
          "Retry-After": "5",
        });
      }
      try {
        // Read after taking the lock, so students who joined meanwhile are included.
        const lab = await findLab(ctx, found.id);
        const content = await templateContent(lab);
        if (!content) throw invalid("Set a template share before distributing");

        // Every student gets a fresh copy; the previous copy is no longer linked to the lab.
        await mapLimit(lab.students, 4, async (student) => {
          const { share } = await forkForStudent(
            lab,
            student.clientId,
            content,
            request.session.ip,
          );
          await alignLock(
            share,
            await ctx.stores.labs.addStudent(lab.id, { ...student, shareId: share.id }),
          );
          await ctx.publishUser(student.clientId, {
            event: "lab",
            data: { labId: lab.id, kind: "distributed" },
          });
        });
        await ctx.audit(request, "lab.distribute", lab.templateShareId ?? undefined, {
          labId: lab.id,
          count: lab.students.length,
        });
        return { count: lab.students.length };
      } finally {
        await release(lockKey, lockToken);
      }
    },
  );
}
