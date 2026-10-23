import {
  createShareResponseSchema,
  MAX_FILES_PER_SHARE,
  uploadParamsSchema,
  uploadQuerySchema,
  uploadResponseSchema,
} from "@codesh/shared";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { ApiError, forbidden, invalid, notFound, tooLarge } from "../errors.js";
import { attachment, basename, decodeText, sanitizePath } from "../files.js";
import { createShare } from "../shares.js";
import { getUploadMeta, mayDownload, storeUpload } from "../uploads.js";
import { type App, limited } from "./types.js";

const MAX_ZIP_ENTRIES = 5000;
const JUNK = /(^|\/)(__MACOSX|\.git|node_modules)(\/|$)|(^|\/)\.DS_Store$/;

interface Received {
  name: string;
  contentType: string | null;
  data: Buffer;
}

const isZip = (name: string) => /\.zip$/i.test(name);

/** Text files of a zip; binary files and junk folders are skipped, bombs are refused. */
function unpack(data: Uint8Array, maxBytes: number): { path: string; content: string }[] {
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(file) {
        if (file.name.endsWith("/") || JUNK.test(file.name)) return false;
        if (++entries > MAX_ZIP_ENTRIES) throw tooLarge("The zip holds too many files");
        total += file.originalSize;
        if (total > maxBytes) throw tooLarge("The zip is too large once unpacked");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid("Not a valid zip file");
  }
  return textFiles(Object.entries(files).map(([path, bytes]) => ({ path, bytes })));
}

function textFiles(
  files: { path: string; bytes: Uint8Array }[],
): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const file of files) {
    const path = sanitizePath(file.path);
    if (path === null || JUNK.test(path)) continue;
    const content = decodeText(file.bytes);
    if (content !== null) out.push({ path, content });
  }
  return out;
}

/** The folder every path starts with, if there is exactly one, else null. */
function commonRoot(paths: string[]): string | null {
  const roots = new Set(paths.map((path) => (path.includes("/") ? path.split("/")[0] : null)));
  const [only] = [...roots];
  return roots.size === 1 && only ? only : null;
}

export function transferRoutes(app: App, ctx: Ctx): void {
  app.post(
    "/api/uploads",
    {
      preHandler: limited(ctx, "create", ctx.config.rateLimit.createPerMinute),
      schema: {
        querystring: uploadQuerySchema,
        response: { 200: z.union([uploadResponseSchema, createShareResponseSchema]) },
      },
    },
    async (request) => {
      if (!request.isMultipart()) throw invalid("Expected multipart/form-data");
      const { session } = request;
      const settings = await ctx.settings();
      const maxBytes = Math.floor(settings.maxUploadMB * 1024 * 1024);

      const received: Received[] = [];
      let total = 0;
      for await (const part of request.parts({ limits: { fileSize: maxBytes } })) {
        if (part.type !== "file") continue;
        const data = await part.toBuffer();
        total += data.byteLength;
        if (total > maxBytes) throw tooLarge(`Uploads are limited to ${settings.maxUploadMB} MB`);
        received.push({ name: part.filename, contentType: part.mimetype || null, data });
      }
      if (received.length === 0) throw invalid("No files in the upload");

      if (request.query.asShare !== "1") {
        const stored = [];
        for (const file of received) {
          const name = sanitizePath(file.name) ?? "upload";
          const meta = await storeUpload(ctx, {
            name: basename(name),
            contentType: file.contentType,
            ownerId: session.clientId,
            data: file.data,
          });
          stored.push({ uploadId: meta.id, name: meta.name, size: meta.size });
        }
        await ctx.audit(request, "upload.create", undefined, { count: stored.length });
        return stored;
      }

      const entries = received.flatMap((file) =>
        isZip(file.name)
          ? unpack(file.data, maxBytes)
          : textFiles([{ path: file.name, bytes: file.data }]),
      );
      if (entries.length === 0) throw invalid("No text files found in the upload");
      if (entries.length > MAX_FILES_PER_SHARE) {
        throw tooLarge(`A share holds at most ${MAX_FILES_PER_SHARE} files`);
      }
      const seen = new Set<string>();
      const files = entries
        .filter((entry) => !seen.has(entry.path) && seen.add(entry.path))
        .sort((a, b) => a.path.localeCompare(b.path));

      const first = received[0] as Received;
      const title =
        received.length === 1
          ? basename(first.name).replace(/\.zip$/i, "")
          : (commonRoot(files.map((file) => file.path)) ?? "");
      const { response } = await createShare(ctx, {
        ownerId: session.clientId,
        title,
        files,
        net: session.net,
      });
      await ctx.audit(request, "upload.share", response.id, { files: files.length });
      return response;
    },
  );

  app.get(
    "/api/uploads/:uploadId",
    { schema: { params: uploadParamsSchema } },
    async (request, reply) => {
      const meta = await getUploadMeta(ctx, request.params.uploadId);
      if (!meta) throw notFound("Upload not found");
      if (meta.expiresAt <= Date.now()) throw new ApiError("expired", "This upload has expired");
      if (!(await mayDownload(ctx, meta, request.session))) {
        throw forbidden("This file was not sent to you");
      }
      const stored = await ctx.stores.files.get(meta.id);
      if (!stored) throw notFound("Upload not found");
      await ctx.audit(request, "upload.download", undefined, { uploadId: meta.id });
      // Never the uploader's content type: the browser must save the file, not render it.
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", attachment(meta.name))
        .send(Buffer.from(stored.data));
    },
  );
}
