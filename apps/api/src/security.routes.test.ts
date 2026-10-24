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


});
