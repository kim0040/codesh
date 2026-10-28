import {
  createShareResponseSchema,
  MAX_FILES_PER_SHARE,
  MAX_TITLE_LENGTH,
  uploadParamsSchema,
  uploadQuerySchema,
  uploadResponseSchema,
} from "@gachipad/shared";
import { FileTooLargeError } from "@gachipad/storage";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { ApiError, forbidden, invalid, notFound, tooLarge } from "../errors.js";
import { attachment, basename, decodeText, sanitizePath, utf8Length } from "../files.js";
import { chargeQuota, chargeUpload } from "../quotas.js";
import { createShare } from "../shares.js";
import {
  discardUpload,
  getUploadMeta,
  mayDownload,
  storeUpload,
  type UploadMeta,
} from "../uploads.js";
import { type App, limited } from "./types.js";

const MAX_ZIP_ENTRIES = 5000;
const JUNK = /(^|\/)(__MACOSX|\.git|node_modules)(\/|$)|(^|\/)\.DS_Store$/;
/** Compressed bytes handed to the unzipper at once, which bounds what one push can inflate. */
const ZIP_SLICE_BYTES = 16 * 1024;
/** Bytes looked at to tell binary content from text, as in `decodeText`. */
const SNIFF_BYTES = 8000;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const EMPTY_ZIP_MAGIC = [0x50, 0x4b, 0x05, 0x06];

const isZip = (name: string) => /\.zip$/i.test(name);

type Entry = { path: string; content: string };

/** What one `asShare` request may take in, so it never holds more than a share could keep. */
interface Budget {
  /** Bytes read from the request, all files together. */
  received: number;
  /** Bytes inflated from zip entries. */
  inflated: number;
  /** UTF-8 bytes of the text files found so far. */
  text: number;
  maxBytes: number;
  maxDocBytes: number;
  maxUploadMB: number;
}

const startsWith = (bytes: Uint8Array, magic: number[]) =>
  magic.every((byte, index) => bytes[index] === byte);

/** Counts what the request sends and refuses it once it passes `settings.maxUploadMB`. */
async function* counted(source: AsyncIterable<Uint8Array>, budget: Budget) {
  for await (const chunk of source) {
    budget.received += chunk.byteLength;
    if (budget.received > budget.maxBytes) {
      throw tooLarge(`Uploads are limited to ${budget.maxUploadMB} MB`);
    }
    yield chunk;
  }
}

function addText(budget: Budget, content: string) {
  budget.text += utf8Length(content);
  if (budget.text > budget.maxDocBytes) {
    throw tooLarge(`A share holds at most ${budget.maxDocBytes} bytes of text`);
  }
}

/**
 * Text files of a zip, read as a stream: only one entry is in memory at a time. Binary files and
 * junk folders are skipped, as are entries too big to be a text file of a share (by their declared
 * size, so they are not even inflated); bombs are refused. The unpacked text may not exceed what
 * a share can hold.
 */
async function unpack(source: AsyncIterable<Uint8Array>, budget: Budget): Promise<Entry[]> {
  const out: Entry[] = [];
  let failure: ApiError | null = null;
  let entries = 0;
  let open = 0;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (failure || file.name.endsWith("/") || JUNK.test(file.name)) return;
    if (++entries > MAX_ZIP_ENTRIES) {
      failure = tooLarge("The zip holds too many files");
      return;
    }
    if (file.originalSize !== undefined && file.originalSize > budget.maxDocBytes) return;
    const parts: Uint8Array[] = [];
    let size = 0;
    let skipped = false;
    open++;
    file.ondata = (error, chunk, final) => {
      if (failure || skipped) {
        if (final) open--;
        return;
      }
      if (error) {
        failure = invalid("Not a valid zip file");
        return;
      }
      size += chunk.length;
      budget.inflated += chunk.length;
      if (budget.inflated > budget.maxBytes) {
        failure = tooLarge("The zip is too large once unpacked");
        file.terminate();
        return;
      }
      if (size > budget.maxDocBytes) {
        // Larger than any text file of a share: treated like a binary file.
        skipped = true;
        parts.length = 0;
        open--;
        file.terminate();
        return;
      }
      parts.push(chunk);
      if (!final) return;
      open--;
      const path = sanitizePath(file.name);
      const content = path === null || JUNK.test(path) ? null : decodeText(Buffer.concat(parts));
      if (path !== null && content !== null) {
        try {
          addText(budget, content);
        } catch (error) {
          failure = error as ApiError;
          return;
        }
        out.push({ path, content });
      }
    };
    file.start();
  };

  let first = true;
  try {
    for await (const chunk of counted(source, budget)) {
      if (first) {
        first = false;
        if (!startsWith(chunk, ZIP_MAGIC) && !startsWith(chunk, EMPTY_ZIP_MAGIC)) {
          throw invalid("Not a valid zip file");
        }
      }
      for (let offset = 0; offset < chunk.length; offset += ZIP_SLICE_BYTES) {
        unzip.push(chunk.subarray(offset, offset + ZIP_SLICE_BYTES));
        if (failure) throw failure;
      }
    }
    unzip.push(new Uint8Array(0), true);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid("Not a valid zip file");
  }
  if (failure) throw failure;
  // An entry that never ended: the zip is cut off.
  if (first || open > 0) throw invalid("Not a valid zip file");
  return out;
}

/**
 * A single uploaded file as a text file. At most `maxDocBytes` are kept; a longer file is
 * skipped when it looks binary (it cannot be shown anyway) and refused when it is text.
 */
async function readTextFile(
  name: string,
  source: AsyncIterable<Uint8Array>,
  budget: Budget,
): Promise<Entry[]> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  let binary = false;
  for await (const chunk of counted(source, budget)) {
    if (overflow) continue;
    if (size < SNIFF_BYTES && chunk.subarray(0, SNIFF_BYTES - size).includes(0)) binary = true;
    size += chunk.byteLength;
    if (size > budget.maxDocBytes) {
      overflow = true;
      chunks.length = 0;
    } else {
      chunks.push(chunk);
    }
  }
  if (overflow) {
    if (binary) return [];
    throw tooLarge(`A share holds at most ${budget.maxDocBytes} bytes of text`);
  }
  const path = sanitizePath(name);
  const content = path === null || JUNK.test(path) ? null : decodeText(Buffer.concat(chunks));
  if (path === null || content === null) return [];
  addText(budget, content);
  return [{ path, content }];
}

/** A title the share schema accepts: trimmed, at most `MAX_TITLE_LENGTH` characters. */
function capTitle(title: string): string {
  let capped = title.trim().slice(0, MAX_TITLE_LENGTH);
  // Do not end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(capped)) capped = capped.slice(0, -1);
  return capped.trim();
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
      await chargeQuota(ctx, session.clientId, session.ip, "uploads");
      const settings = await ctx.settings();
      const maxBytes = Math.floor(settings.maxUploadMB * 1024 * 1024);
      const tooBig = () => tooLarge(`Uploads are limited to ${settings.maxUploadMB} MB`);

      if (request.query.asShare !== "1") {
        // Streamed into the FileStore one file after the other; a request that fails halfway
        // takes its earlier files with it.
        const stored: UploadMeta[] = [];
        let total = 0;
        try {
          for await (const part of request.parts()) {
            if (part.type !== "file") continue;
            const meta = await storeUpload(ctx, {
              ip: session.ip,
              name: basename(sanitizePath(part.filename) ?? "upload"),
              contentType: part.mimetype || null,
              ownerId: session.clientId,
              stream: chargeUpload(ctx, session.clientId, session.ip, part.file),
              maxBytes: maxBytes - total,
            });
            stored.push(meta);
            total += meta.size;
          }
          if (stored.length === 0) throw invalid("No files in the upload");
        } catch (error) {
          for (const meta of stored) await discardUpload(ctx, meta);
          throw error instanceof FileTooLargeError ? tooBig() : error;
        }
        await ctx.audit(request, "upload.create", undefined, { count: stored.length });
        return stored.map((meta) => ({ uploadId: meta.id, name: meta.name, size: meta.size }));
      }

      const budget: Budget = {
        received: 0,
        inflated: 0,
        text: 0,
        maxBytes,
        maxDocBytes: settings.maxDocBytes,
        maxUploadMB: settings.maxUploadMB,
      };
      const names: string[] = [];
      const entries: Entry[] = [];
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        names.push(part.filename);
        entries.push(
          ...(isZip(part.filename)
            ? await unpack(chargeUpload(ctx, session.clientId, session.ip, part.file), budget)
            : await readTextFile(
                part.filename,
                chargeUpload(ctx, session.clientId, session.ip, part.file),
                budget,
              )),
        );
      }
      if (names.length === 0) throw invalid("No files in the upload");
      if (entries.length === 0) throw invalid("No text files found in the upload");
      if (entries.length > MAX_FILES_PER_SHARE) {
        throw tooLarge(`A share holds at most ${MAX_FILES_PER_SHARE} files`);
      }
      const seen = new Set<string>();
      const files = entries
        .filter((entry) => !seen.has(entry.path) && seen.add(entry.path))
        .sort((a, b) => a.path.localeCompare(b.path));

      const title = capTitle(
        names.length === 1
          ? basename(names[0] as string).replace(/\.zip$/i, "")
          : (commonRoot(files.map((file) => file.path)) ?? ""),
      );
      const { response } = await createShare(ctx, {
        ownerId: session.clientId,
        ip: session.ip,
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
      const stored = await ctx.stores.files.openDownload(meta.id);
      if (!stored) throw notFound("Upload not found");
      await ctx.audit(request, "upload.download", undefined, { uploadId: meta.id });
      // Never the uploader's content type: the browser must save the file, not render it.
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", attachment(meta.name))
        .header("Content-Length", stored.meta.size)
        .send(stored.stream);
    },
  );
}
