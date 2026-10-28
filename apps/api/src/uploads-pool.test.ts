import { keys } from "@gachipad/shared";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { Ctx } from "./ctx.js";
import { createHarness, type Harness, integration } from "./testing/harness.js";
import { discardUpload, storeUpload } from "./uploads.js";

describe.skipIf(!integration)("public streamed upload pool", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  async function setup() {
    const config = loadConfig({ UPLOAD_STORAGE_MAX_BYTES: "100" });
    h = await createHarness({
      config: { network: "public", publicUrl: "https://share.example.org", limits: config.limits },
    });
    return {
      config: h.config,
      stores: h.stores,
      valkey: h.valkey,
      settings: () => h.stores.settings.get(),
    } as Ctx;
  }

  function upload(ctx: Ctx, sizes: number[]) {
    return storeUpload(ctx, {
      name: "a.txt",
      contentType: null,
      ownerId: "00000000-0000-4000-8000-000000000000",
      ip: "198.51.100.7",
      maxBytes: 100,
      stream: (async function* () {
        for (const size of sizes) yield new Uint8Array(size);
      })(),
    });
  }

  it("accumulates every chunk and releases all held bytes on discard", async () => {
    const ctx = await setup();
    const meta = await upload(ctx, [8, 9, 8]);
    const key = keys.rateLimit("198.51.100.7", "upload-pool");
    expect(meta.size).toBe(25);
    expect(await h.valkey.hvals(`${key}:sizes`)).toEqual(["25"]);
    await expect(upload(ctx, [1])).rejects.toMatchObject({
      code: "upload_pool_limited",
      status: 429,
    });
    expect(await h.valkey.hvals(`${key}:sizes`)).toEqual(["25"]);
    await discardUpload(ctx, meta);
    expect(await h.stores.files.meta(meta.id)).toBeNull();
    expect(await h.valkey.hlen(`${key}:sizes`)).toBe(0);
    expect(await h.valkey.zcard(key)).toBe(0);
    expect((await upload(ctx, [12, 13])).size).toBe(25);
  });

  it("releases earlier chunks when a later chunk exceeds the address pool", async () => {
    const ctx = await setup();
    await expect(upload(ctx, [8, 9, 9])).rejects.toMatchObject({
      code: "upload_pool_limited",
      status: 429,
    });
    const key = keys.rateLimit("198.51.100.7", "upload-pool");
    expect(await h.valkey.hlen(`${key}:sizes`)).toBe(0);
    expect(await h.valkey.zcard(key)).toBe(0);
    expect((await upload(ctx, [5, 10, 10])).size).toBe(25);
  });

  it("purges expired reservations with the Valkey clock before admitting a new stream", async () => {
    const ctx = await setup();
    const meta = await upload(ctx, [10, 15]);
    if (!meta.pool) throw new Error("missing upload pool");
    const [seconds, micros] = await h.valkey.time();
    await h.valkey.zadd(
      meta.pool.key,
      Number(seconds) * 1000 + Number(micros) / 1000 - 1,
      meta.pool.id,
    );
    expect((await upload(ctx, [5, 20])).size).toBe(25);
    expect(await h.valkey.hget(`${meta.pool.key}:sizes`, meta.pool.id)).toBeNull();
    expect(await h.valkey.zcard(meta.pool.key)).toBe(1);
  });
});
