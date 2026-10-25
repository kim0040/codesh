import { channels, type GetShareResponse, participantPermissions } from "@gachipad/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
} from "./testing/harness.js";

describe.skipIf(!integration)("share participant permissions", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it("creates private defaults and exposes only safe capabilities to participants", async () => {
    const owner = h.client();
    const member = h.client();
    const { id } = await createShare(owner);
    const record = await h.stores.shares.get(id);
    expect(record?.access).toMatchObject({
      allowParticipantRename: false,
      allowParticipantFiles: false,
      allowParticipantLanguage: false,
    });
    const ownerView = (await owner.get(`/api/shares/${id}`)).json<GetShareResponse>();
    expect(ownerView.access).toMatchObject({
      allowParticipantRename: false,
      allowParticipantFiles: false,
      allowParticipantLanguage: false,
    });
    const memberView = (await member.get(`/api/shares/${id}`)).json<GetShareResponse>();
    expect(memberView.permissions).toEqual(participantPermissions());
    expect(memberView.access).toBeUndefined();
    expect(JSON.stringify(memberView)).not.toMatch(/editKey|pinHash|generation/);
  });

  it("defaults legacy records safely without requiring a database migration", async () => {
    const owner = h.client();
    const { id } = await createShare(owner);
    const original = await h.stores.shares.get(id);
    if (!original) throw new Error("missing share");
    const {
      allowParticipantRename: _rename,
      allowParticipantFiles: _files,
      allowParticipantLanguage: _language,
      ...access
    } = original.access;
    await h.stores.shares.delete(id);
    await h.stores.shares.create({ ...original, access });
    expect((await owner.get(`/api/shares/${id}`)).json<GetShareResponse>().permissions).toEqual(
      participantPermissions(),
    );
    expect((await h.client().patch(`/api/shares/${id}`, { title: "blocked" })).statusCode).toBe(
      403,
    );
  });

  it("lets only the owner change each toggle and publishes changes live", async () => {
    const owner = h.client();
    const editor = h.client();
    const { id } = await createShare(owner);
    const sub = await h.subscribe(channels.perm(id));
    try {
      for (const field of [
        "allowParticipantRename",
        "allowParticipantFiles",
        "allowParticipantLanguage",
      ] as const) {
        expect(
          (await editor.patch(`/api/shares/${id}`, { access: { [field]: true } })).statusCode,
        ).toBe(403);
        for (const enabled of [true, false]) {
          const patched = await owner.patch(`/api/shares/${id}`, { access: { [field]: enabled } });
          expect(patched.statusCode).toBe(200);
          expect(patched.json<GetShareResponse>().access?.[field]).toBe(enabled);
          expect((await h.stores.shares.get(id))?.access[field]).toBe(enabled);
        }
      }
      await eventually(() => sub.messages.length === 6);
      expect(sub.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "permissions" })]),
      );
      expect(
        (await owner.patch(`/api/shares/${id}`, { access: { allowParticipantFiles: "yes" } }))
          .statusCode,
      ).toBe(400);
    } finally {
      sub.stop();
    }
  });

  it("authorizes title and language separately and atomically denies mixed unauthorized patches", async () => {
    const owner = h.client();
    const editor = h.client();
    const { id } = await createShare(owner);
    expect((await editor.patch(`/api/shares/${id}`, { title: "blocked" })).statusCode).toBe(403);
    await owner.patch(`/api/shares/${id}`, { access: { allowParticipantRename: true } });
    expect((await editor.patch(`/api/shares/${id}`, { title: "Allowed" })).statusCode).toBe(200);
    const before = h.collab.commands.length;
    expect(
      (await editor.patch(`/api/shares/${id}`, { title: "Mixed", language: "go" })).statusCode,
    ).toBe(403);
    expect(h.collab.commands).toHaveLength(before);
    expect((await h.stores.shares.get(id))?.title).toBe("Allowed");
    await owner.patch(`/api/shares/${id}`, { access: { allowParticipantLanguage: true } });
    expect((await editor.patch(`/api/shares/${id}`, { language: "go" })).statusCode).toBe(200);
    expect(h.collab.commands.at(-1)).toMatchObject({ kind: "meta", language: "go" });
    for (const extra of [{ locked: true }, { saved: true }, { access: { nearby: true } }]) {
      expect(
        (await editor.patch(`/api/shares/${id}`, { title: "Escalated", ...extra })).statusCode,
      ).toBe(403);
    }
    expect((await editor.delete(`/api/shares/${id}`)).statusCode).toBe(403);
  });

  it("retains view, lock, PIN, approval and edit-key requirements when toggles are enabled", async () => {
    const owner = h.client();
    const member = h.client();
    const { id } = await createShare(owner);
    await owner.patch(`/api/shares/${id}`, {
      access: {
        allowParticipantRename: true,
        allowParticipantFiles: true,
        allowParticipantLanguage: true,
        default: "view",
      },
    });
    expect((await member.patch(`/api/shares/${id}`, { title: "viewer" })).statusCode).toBe(403);
    const key = (await owner.get(`/api/shares/${id}`)).json<GetShareResponse>().access?.editKey;
    expect((await member.post(`/api/shares/${id}/join`, { editKey: key })).statusCode).toBe(200);
    expect((await member.patch(`/api/shares/${id}`, { title: "editor" })).statusCode).toBe(200);
    await owner.patch(`/api/shares/${id}`, { locked: true });
    expect((await member.patch(`/api/shares/${id}`, { title: "locked" })).statusCode).toBe(403);
    await owner.patch(`/api/shares/${id}`, { locked: false, access: { pin: "1234" } });
    expect((await member.patch(`/api/shares/${id}`, { title: "no pin" })).statusCode).toBe(401);
    expect(
      (await member.get(`/api/shares/${id}`)).json<GetShareResponse>().permissions,
    ).toBeUndefined();
    await member.post(`/api/shares/${id}/join`, { pin: "1234", editKey: key });
    expect((await member.patch(`/api/shares/${id}`, { title: "pin passed" })).statusCode).toBe(200);
    await owner.patch(`/api/shares/${id}`, { access: { pin: null, requireApproval: true } });
    expect((await member.patch(`/api/shares/${id}`, { title: "unapproved" })).statusCode).toBe(403);
  });
});
