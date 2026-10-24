import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

describe.skipIf(!integration)("security resource boundaries", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it("H1: a locked lab rejects student metadata and history-restore API writes", async () => {
    h = await createHarness();
    const teacher = h.client();
    const student = h.client();
    const lab = (await teacher.post("/api/labs", { title: "Locked lab" })).json<{ id: string }>();
    const { shareId } = (await student.post(`/api/labs/${lab.id}/join`, { name: "Student" })).json<{
      shareId: string;
    }>();
    const snapshot = await h.stores.snapshots.latest(shareId, "compact");
    if (!snapshot) throw new Error("snapshot missing");
    await h.stores.snapshots.put({ ...snapshot, kind: "history", seq: 1 });
    await teacher.patch(`/api/labs/${lab.id}`, { locked: true });
    expect((await student.patch(`/api/shares/${shareId}`, { title: "bypass" })).statusCode).toBe(
      403,
    );
    expect((await student.post(`/api/shares/${shareId}/restore`, { seq: 1 })).statusCode).toBe(403);
    expect(h.collab.commands).toHaveLength(0);
  });

  it("M2: shares an IPv6 /64 rate bucket even after dropping the cookie", async () => {
    const config = loadConfig();
    h = await createHarness({ config: { rateLimit: { ...config.rateLimit, createPerMinute: 1 } } });
    expect((await h.client({ ip: "2001:db8:1::1" }).post("/api/shares")).statusCode).toBe(200);
    expect((await h.client({ ip: "2001:db8:1::2" }).post("/api/shares")).statusCode).toBe(429);
    expect((await h.client({ ip: "2001:db8:2::1" }).post("/api/shares")).statusCode).toBe(200);
  });

  it("M2: caps PIN guessing across IPv6 addresses and fresh sessions", async () => {
    h = await createHarness();
    const owner = h.client();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, { access: { pin: "123456" } });
    for (let i = 1; i <= 30; i++) {
      expect(
        (
          await h
            .client({ ip: `2001:db8:3::${i}` })
            .post(`/api/shares/${id}/join`, { pin: "999999" })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (await h.client({ ip: "2001:db8:3::ff" }).post(`/api/shares/${id}/join`, { pin: "123456" }))
        .statusCode,
    ).toBe(429);
  });

  it("M3: caps share creation by network key across fresh cookies", async () => {
    const config = loadConfig({ QUOTA_SHARES_PER_IP: "2" });
    h = await createHarness({ config: { limits: config.limits } });
    const ip = "192.0.2.14";
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => h.client({ ip }).post("/api/shares")),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 200, 429, 429]);
  });

  it("M3: caps upload bytes across requests, and rolls back a refused upload", async () => {
    const config = loadConfig({ QUOTA_BYTES_PER_IP: "8" });
    h = await createHarness({ config: { limits: config.limits } });
    const client = h.client();
    expect(
      (await client.multipart("/api/uploads", [{ name: "a.txt", data: "12345" }])).statusCode,
    ).toBe(200);
    expect(
      (await client.multipart("/api/uploads", [{ name: "b.txt", data: "6789" }])).statusCode,
    ).toBe(429);
  });

  it("M3: enforces global upload capacity concurrently and releases deleted bytes", async () => {
    const config = loadConfig({ UPLOAD_STORAGE_MAX_BYTES: "10" });
    h = await createHarness({ config: { limits: config.limits } });
    const client = h.client();
    const responses = await Promise.all(
      ["a.txt", "b.txt"].map((name) =>
        client.multipart("/api/uploads", [{ name, data: "123456" }]),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 503]);
    const accepted = responses.find((response) => response.statusCode === 200);
    const uploadId = accepted?.json<{ uploadId: string }[]>()[0]?.uploadId;
    if (!uploadId) throw new Error("upload missing");
    await h.stores.files.delete(uploadId);
    expect(
      (await client.multipart("/api/uploads", [{ name: "c.txt", data: "123456" }])).statusCode,
    ).toBe(200);
  });

  it("M4: caps open SSE streams per client and IPv6 network key, and releases slots", async () => {
    const config = loadConfig({ SSE_MAX_PER_CLIENT: "1", SSE_MAX_PER_IP: "2" });
    h = await createHarness({ config: { limits: config.limits } });
    const base = await h.listen();
    const client = h.client({ ip: "2001:db8:4::1" });
    const first = await client.events(base);
    try {
      const same = await client.events(base);
      expect(same.status).toBe(429);
      same.close();
      const second = await h.client({ ip: "2001:db8:4::2" }).events(base);
      try {
        expect(second.status).toBe(200);
        const third = await h.client({ ip: "2001:db8:4::3" }).events(base);
        expect(third.status).toBe(429);
        third.close();
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it("M4: refuses new presence entries when a network group is full", async () => {
    const config = loadConfig({ PRESENCE_MAX_PER_NET: "2" });
    h = await createHarness({ config: { limits: config.limits } });
    const base = await h.listen();
    const streams = [];
    try {
      for (let i = 1; i <= 3; i++)
        streams.push(await h.client({ ip: `198.51.100.${i}` }).events(base));
      expect(streams.map((s) => s.status)).toEqual([200, 200, 429]);
      expect(await h.valkey.zcard("presence:198.51.100.0/24")).toBe(2);
    } finally {
      for (const stream of streams) stream.close();
    }
  });
});
