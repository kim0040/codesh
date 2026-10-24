import { afterEach, describe, expect, it } from "vitest";
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


});
