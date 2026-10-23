import { randomUUID } from "node:crypto";
import {
  apiKeys,
  COLLAB_COMMAND_ERRORS,
  type CollabCommand,
  type CollabCommandError,
  type CollabCommandReply,
  channels,
  collabCommandReplySchema,
  DEFAULT_FILE_ID,
  generateFileId,
  type ShareRecord,
  YDOC,
} from "@codesh/shared";
import * as Y from "yjs";
import type { Ctx } from "./ctx.js";
import { ApiError, invalid, notFound, tooLarge } from "./errors.js";
import { firstLines, utf8Length } from "./files.js";

/**
 * Server-side access to the Y.Doc of a share (§4): build and read it, and ask collab to change it.
 * Only apps/collab writes `share_updates` (§6.11); the API never appends to the update log.
 */

export interface NewFile {
  path: string;
  language: string;
  content: string;
}

export interface DocFile extends NewFile {
  id: string;
  order: number;
}

export interface DocContent {
  title: string;
  language: string;
  files: DocFile[];
}

export const UNTITLED_PATH = "untitled";

/** A fresh document; the first file gets the id `main`, later ones random ids (§3). */
export function buildDoc(input: { title: string; language: string; files: NewFile[] }): Y.Doc {
  const doc = new Y.Doc();
  const files =
    input.files.length > 0
      ? input.files
      : [{ path: UNTITLED_PATH, language: input.language, content: "" }];
  doc.transact(() => {
    const meta = doc.getMap<string>(YDOC.meta);
    meta.set("title", input.title);
    meta.set("language", input.language);
    const map = doc.getMap<Y.Map<unknown>>(YDOC.files);
    const used = new Set<string>();
    for (const [order, file] of files.entries()) {
      let id = DEFAULT_FILE_ID;
      if (order > 0) {
        do id = generateFileId();
        while (used.has(id));
      }
      used.add(id);
      const entry = new Y.Map<unknown>();
      map.set(id, entry);
      entry.set("path", file.path);
      entry.set("language", file.language);
      entry.set("order", order);
      doc.getText(YDOC.fileText(id)).insert(0, file.content);
    }
  });
  return doc;
}

export function readContent(doc: Y.Doc): DocContent {
  const meta = doc.getMap<unknown>(YDOC.meta);
  const files: DocFile[] = [];
  for (const [id, entry] of doc.getMap<unknown>(YDOC.files).entries()) {
    if (!(entry instanceof Y.Map)) continue;
    files.push({
      id,
      path: String(entry.get("path") ?? id),
      language: String(entry.get("language") ?? ""),
      order: Number(entry.get("order") ?? 0),
      content: doc.getText(YDOC.fileText(id)).toString(),
    });
  }
  files.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return {
    title: String(meta.get("title") ?? ""),
    language: String(meta.get("language") ?? ""),
    files,
  };
}

export const contentBytes = (content: DocContent) =>
  content.files.reduce((sum, file) => sum + utf8Length(file.content), 0);

/** The stored state: newest compact snapshot plus the updates after it (§6.4). */
export async function loadDoc(ctx: Ctx, shareId: string): Promise<Y.Doc> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await ctx.stores.snapshots.latest(shareId, "compact");
    const base = snapshot?.seq ?? 0;
    const updates = await ctx.stores.updates.read(shareId, base);
    const after = await ctx.stores.snapshots.latest(shareId, "compact");
    // A compaction between the two reads deletes updates we expected to find; read again.
    if ((after?.seq ?? 0) !== base && attempt < 3) continue;
    const doc = new Y.Doc();
    if (snapshot) Y.applyUpdate(doc, snapshot.state);
    for (const update of updates) Y.applyUpdate(doc, update.data);
    return doc;
  }
}

/** Stores a brand new document as the first snapshot (seq 0), so collab loads it like any other. */
export async function storeInitialState(ctx: Ctx, shareId: string, doc: Y.Doc): Promise<void> {
  await ctx.stores.snapshots.put({
    shareId,
    seq: 0,
    state: new Uint8Array(Y.encodeStateAsUpdate(doc)),
    at: new Date(),
    kind: "compact",
  });
}

/** A command without its `requestId`, which `sendCommand` adds. */
export type CommandBody = CollabCommand extends infer C
  ? C extends unknown
    ? Omit<C, "requestId">
    : never
  : never;

const unavailable = () => new ApiError("unavailable", "The collaboration service did not answer");

function commandError(error: CollabCommandError | undefined): ApiError {
  switch (error) {
    case COLLAB_COMMAND_ERRORS.notFound:
      return notFound("Share not found");
    case COLLAB_COMMAND_ERRORS.snapshotNotFound:
      return notFound("No such history entry");
    case COLLAB_COMMAND_ERRORS.fileNotFound:
      return notFound("No such file");
    case COLLAB_COMMAND_ERRORS.tooLarge:
      return tooLarge("The document would become too large");
    case COLLAB_COMMAND_ERRORS.invalid:
      return invalid("The change was refused");
    default:
      return unavailable();
  }
}

/**
 * Asks collab to change a document (§6.11): publishes on `cmd:<shareId>` and waits for the reply on
 * `cmd-reply:<requestId>`. The reply channel is subscribed before publishing, so a fast reply is
 * never missed. A refused command becomes the matching API error; no reply within
 * `COLLAB_COMMAND_TIMEOUT_MS` is `unavailable` (503).
 */
export async function sendCommand(ctx: Ctx, shareId: string, body: CommandBody): Promise<void> {
  const requestId = randomUUID();
  const command = { ...body, requestId } as CollabCommand;
  let settle!: (reply: CollabCommandReply | "timeout") => void;
  const outcome = new Promise<CollabCommandReply | "timeout">((resolve) => {
    settle = resolve;
  });
  const stop = await ctx.hub.subscribe(channels.cmdReply(requestId), (message) => {
    try {
      const reply = collabCommandReplySchema.safeParse(JSON.parse(message));
      if (reply.success) settle(reply.data);
    } catch {
      // Not JSON: not from collab.
    }
  });
  const timer = setTimeout(() => settle("timeout"), ctx.commandTimeoutMs);
  try {
    await ctx.valkey.publish(channels.cmd(shareId), JSON.stringify(command));
    const reply = await outcome;
    if (reply === "timeout") throw unavailable();
    if (!reply.ok) throw commandError(reply.error);
  } finally {
    clearTimeout(timer);
    stop();
  }
}

/**
 * First lines of the main file for lists. Valkey caches it for a minute; behind that it is kept in
 * the share record, which is current while nobody touched the share since (collab sets
 * `updatedAt` on activity), so a list of 100 shares does not load 100 documents on a cold cache.
 */
export async function sharePreview(
  ctx: Ctx,
  share: Pick<ShareRecord, "id" | "updatedAt" | "preview" | "previewAt">,
): Promise<string> {
  const key = apiKeys.preview(share.id);
  const cached = await ctx.valkey.get(key);
  if (cached !== null) return cached;
  let preview = share.preview;
  if (preview === undefined || !share.previewAt || share.updatedAt > share.previewAt) {
    const at = new Date();
    const content = readContent(await loadDoc(ctx, share.id));
    preview = previewOf(content);
    await ctx.stores.shares.update(share.id, { preview, previewAt: at }).catch(() => undefined);
  }
  await ctx.valkey.set(key, preview, "EX", 60);
  return preview;
}

export function previewOf(content: DocContent): string {
  const main = content.files.find((file) => file.id === DEFAULT_FILE_ID) ?? content.files[0];
  return main ? firstLines(main.content) : "";
}
