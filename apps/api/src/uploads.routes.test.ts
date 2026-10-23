import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readContent } from "./docs.js";
import {
  type Client,
  createHarness,
  type Harness,
  integration,
  storedDoc,
} from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

interface Uploaded {
  uploadId: string;
  name: string;
  size: number;
}
interface Created {
  id: string;
  code: string;
  url: string;
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff, 0xfe]);

describe.skipIf(!integration)("POST /api/uploads and GET /api/uploads/:uploadId", () => {
  let h: Harness;
  let net: ReturnType<Harness["network"]>;
  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(() => {
    net = h.network();
  });
  afterAll(() => h.close());

  const upload = (
    client: Client,
    files: { name: string; data: Uint8Array | string; type?: string }[],
  ) => client.multipart("/api/uploads", files);

  it("stores files and lets the uploader download them as attachments", async () => {
    const me = net.client();
    const meId = await me.clientId();
    const response = await upload(me, [
      { name: "diagram.png", data: png, type: "image/png" },
      { name: "한글 메모.txt", data: "안녕", type: "text/html" },
    ]);
    expect(response.statusCode).toBe(200);
    const [first, second] = response.json<Uploaded[]>();
    expect(first).toMatchObject({ name: "diagram.png", size: png.byteLength });
    expect(second).toMatchObject({ name: "한글 메모.txt", size: Buffer.byteLength("안녕") });

    const stored = await h.stores.files.get(first?.uploadId as string);
    expect(stored?.meta).toMatchObject({
      ownerId: meId,
      name: "diagram.png",
      contentType: "image/png",
    });
    expect(Array.from(stored?.data ?? [])).toEqual(Array.from(png));
    const meta = await h.valkey.hgetall(`upload:meta:${first?.uploadId}`);
    expect(meta).toMatchObject({
      name: "diagram.png",
      size: String(png.byteLength),
      ownerId: meId,
    });
    expect(
      await h.valkey.zscore("uploads:index", `${first?.uploadId}:${png.byteLength}`),
    ).not.toBeNull();

    const download = await me.get(`/api/uploads/${first?.uploadId}`);
    expect(download.statusCode).toBe(200);
    expect(Array.from(download.rawPayload)).toEqual(Array.from(png));
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(String(download.headers["content-disposition"])).toMatch(
      /^attachment; filename="diagram\.png"/,
    );

    // The uploader's claimed type (text/html) must never be served back as such.
    const text = await me.get(`/api/uploads/${second?.uploadId}`);
    expect(text.headers["content-type"]).toBe("application/octet-stream");
    expect(text.body).toBe("안녕");
    expect(String(text.headers["content-disposition"])).toContain(
      `filename*=UTF-8''${encodeURIComponent("한글 메모.txt")}`,
    );
  });

  it("keeps files private until the owner sends them", async () => {
    const me = net.client();
    const bob = net.client();
    const stranger = h.client({ ip: "172.26.1.1" });
    const [file] = (await upload(me, [{ name: "a.bin", data: png }])).json<Uploaded[]>();
    const url = `/api/uploads/${file?.uploadId}`;

    const denied = await bob.get(url);
    expect(denied.statusCode).toBe(403);
    expect(errorCode(denied)).toBe("forbidden");

    // An invite to Bob grants Bob only.
    const bobId = await bob.clientId();
    await h.valkey.zadd(
      `presence:${me.ip.split(".").slice(0, 3).join(".")}.0/24`,
      Date.now(),
      bobId,
    );
    const { id } = (await me.post("/api/shares")).json<Created>();
    expect(
      (await me.post("/api/invites", { to: bobId, shareId: id, uploadId: file?.uploadId }))
        .statusCode,
    ).toBe(200);
    expect(await h.valkey.sismember(`upload:grants:${file?.uploadId}`, bobId)).toBe(1);
    expect((await bob.get(url)).statusCode).toBe(200);
    expect((await net.client().get(url)).statusCode).toBe(403);

    // Showing it to the whole network group grants the group, not the world.
    await me.post("/api/invites", { to: "net", shareId: id, uploadId: file?.uploadId });
    expect((await net.client().get(url)).statusCode).toBe(200);
    expect((await stranger.get(url)).statusCode).toBe(403);
  });

  it("refuses to send a file the sender did not upload, or one that does not exist", async () => {
    const me = net.client();
    const other = net.client();
    const bob = net.client();
    const bobId = await bob.clientId();
    await h.valkey.zadd(
      `presence:${me.ip.split(".").slice(0, 3).join(".")}.0/24`,
      Date.now(),
      bobId,
    );
    const { id } = (await me.post("/api/shares")).json<Created>();
    const [file] = (await upload(other, [{ name: "x.bin", data: png }])).json<Uploaded[]>();

    const stolen = await me.post("/api/invites", {
      to: bobId,
      shareId: id,
      uploadId: file?.uploadId,
    });
    expect(stolen.statusCode).toBe(403);
    expect(await h.valkey.sismember(`upload:grants:${file?.uploadId}`, bobId)).toBe(0);
    const missing = await me.post("/api/invites", { to: bobId, shareId: id, uploadId: "nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("answers 404 for unknown uploads and 410 once an upload expired", async () => {
    const me = net.client();
    const missing = await me.get("/api/uploads/does-not-exist");
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("not_found");

    const [file] = (await upload(me, [{ name: "old.bin", data: png }])).json<Uploaded[]>();
    await h.valkey.hset(`upload:meta:${file?.uploadId}`, "expiresAt", String(Date.now() - 1000));
    const expired = await me.get(`/api/uploads/${file?.uploadId}`);
    expect(expired.statusCode).toBe(410);
    expect(errorCode(expired)).toBe("expired");
  });

  it("falls back to the file store when Valkey lost the metadata", async () => {
    const me = net.client();
    const [file] = (await upload(me, [{ name: "kept.bin", data: png }])).json<Uploaded[]>();
    await h.valkey.del(`upload:meta:${file?.uploadId}`);
    const download = await me.get(`/api/uploads/${file?.uploadId}`);
    expect(download.statusCode).toBe(200);
    expect(await h.valkey.hget(`upload:meta:${file?.uploadId}`, "ownerId")).toBe(
      await me.clientId(),
    );
  });

  it("answers 413 too_large above settings.maxUploadMB, for one file or for all together", async () => {
    const small = await createHarness();
    try {
      await small.stores.settings.put({
        ...(await small.stores.settings.get()),
        maxUploadMB: 0.001,
      });
      const me = small.client();
      const big = new Uint8Array(2000).fill(65);
      const single = await me.multipart("/api/uploads", [{ name: "big.bin", data: big }]);
      expect(single.statusCode).toBe(413);
      expect(errorCode(single)).toBe("too_large");

      const many = await me.multipart("/api/uploads", [
        { name: "a.bin", data: big.slice(0, 600) },
        { name: "b.bin", data: big.slice(0, 600) },
      ]);
      expect(many.statusCode).toBe(413);
      expect(errorCode(many)).toBe("too_large");

      const fits = await me.multipart("/api/uploads", [
        { name: "ok.bin", data: big.slice(0, 900) },
      ]);
      expect(fits.statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });

  it("answers 400 for a request that is not multipart or holds no file", async () => {
    const me = net.client();
    const notMultipart = await me.post("/api/uploads", { hello: "world" });
    expect(notMultipart.statusCode).toBe(400);
    expect(errorCode(notMultipart)).toBe("validation");
    const form = new Response(new FormData());
    const empty = await me.request("POST", "/api/uploads", {
      payload: Buffer.from(await form.arrayBuffer()),
      headers: { "content-type": form.headers.get("content-type") as string },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe.skipIf(!integration)("POST /api/uploads?asShare=1", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const asShare = (client: Client, files: { name: string; data: Uint8Array | string }[]) =>
    client.multipart("/api/uploads?asShare=1", files);

  it("unpacks a zip into a multi-file share, skipping binaries and junk", async () => {
    const me = h.client();
    const meId = await me.clientId();
    const zip = zipSync({
      "proj/src/index.ts": strToU8("export const answer = 42;\n"),
      "proj/README.md": strToU8("# Project\n"),
      "proj/한글.py": strToU8("print('안녕')\n"),
      "proj/logo.png": png,
      "__MACOSX/proj/._README.md": strToU8("junk"),
      "proj/.git/config": strToU8("[core]"),
      "proj/node_modules/x/index.js": strToU8("module.exports = 1"),
      "proj/.DS_Store": strToU8("x"),
    });
    const response = await asShare(me, [{ name: "proj.zip", data: zip }]);
    expect(response.statusCode).toBe(200);
    const { id, code, url } = response.json<Created>();
    expect(url).toBe(`/${id}`);
    expect(await h.valkey.get(`code:${code}`)).toBe(id);

    const share = await h.stores.shares.get(id);
    expect(share).toMatchObject({ ownerId: meId, title: "proj" });
    const content = readContent(await storedDoc(h.stores, id));
    expect(content.files.map((f) => [f.path, f.language])).toEqual([
      ["proj/README.md", "markdown"],
      ["proj/src/index.ts", "typescript"],
      ["proj/한글.py", "python"],
    ]);
    expect(content.files[0]?.id).toBe("main");
    expect(content.files.find((f) => f.path === "proj/src/index.ts")?.content).toBe(
      "export const answer = 42;\n",
    );
    // The first state is a snapshot, so collab can load it straight away.
    expect((await h.stores.snapshots.latest(id, "compact"))?.seq).toBe(0);
    expect(share?.sizeBytes).toBe(
      content.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0),
    );
    // The uploader can open it as the owner.
    expect((await me.get(`/api/shares/${id}`)).json<{ role: string }>().role).toBe("owner");
  });

  it("turns a folder upload (relative paths as file names) into one share named after the folder", async () => {
    const me = h.client();
    const response = await asShare(me, [
      { name: "app/main.py", data: "print(1)\n" },
      { name: "app/lib/util.py", data: "x = 1\n" },
      { name: "app/data.bin", data: png },
    ]);
    expect(response.statusCode).toBe(200);
    const { id } = response.json<Created>();
    expect((await h.stores.shares.get(id))?.title).toBe("app");
    const content = readContent(await storedDoc(h.stores, id));
    expect(content.files.map((f) => f.path)).toEqual(["app/lib/util.py", "app/main.py"]);
  });

  it("opens a single text file as a share titled with its name", async () => {
    const me = h.client();
    const { id } = (await asShare(me, [{ name: "notes.md", data: "# Notes\n" }])).json<Created>();
    const share = await h.stores.shares.get(id);
    expect(share).toMatchObject({ title: "notes.md", language: "markdown" });
  });

  it("answers 400 for a broken zip or an upload without any text file", async () => {
    const me = h.client();
    const broken = await asShare(me, [{ name: "bad.zip", data: "this is not a zip" }]);
    expect(broken.statusCode).toBe(400);
    expect(errorCode(broken)).toBe("validation");
    const binaryOnly = await asShare(me, [{ name: "logo.png", data: png }]);
    expect(binaryOnly.statusCode).toBe(400);
    expect(errorCode(binaryOnly)).toBe("validation");
  });

  it("never lets a zip entry escape its root", async () => {
    const me = h.client();
    const zip = zipSync({
      "../evil.txt": strToU8("x"),
      "a/../../evil2.txt": strToU8("x"),
      "safe.txt": strToU8("ok"),
    });
    const { id } = (await asShare(me, [{ name: "evil.zip", data: zip }])).json<Created>();
    expect(readContent(await storedDoc(h.stores, id)).files.map((f) => f.path)).toEqual([
      "safe.txt",
    ]);
  });

  it("refuses a zip that is too large once unpacked, or that holds too many files", async () => {
    const small = await createHarness();
    try {
      await small.stores.settings.put({ ...(await small.stores.settings.get()), maxUploadMB: 1 });
      const me = small.client();
      const bomb = zipSync({ "zeros.txt": new Uint8Array(5 * 1024 * 1024).fill(97) });
      expect(bomb.byteLength).toBeLessThan(1024 * 1024);
      const huge = await asShare(me, [{ name: "bomb.zip", data: bomb }]);
      expect(huge.statusCode).toBe(413);
      expect(errorCode(huge)).toBe("too_large");

      const many = zipSync(
        Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}.txt`, strToU8("x")])),
      );
      const tooMany = await asShare(me, [{ name: "many.zip", data: many }]);
      expect(tooMany.statusCode).toBe(413);
      expect(errorCode(tooMany)).toBe("too_large");
    } finally {
      await small.close();
    }
  });
});
