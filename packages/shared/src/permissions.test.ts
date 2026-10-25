import { describe, expect, it } from "vitest";
import { canChangeDocument, participantPermissions } from "./permissions.js";
import { accessSchema } from "./records.js";

describe("participant permissions", () => {
  it("defaults older access records to owner-only metadata and structure", () => {
    const old = accessSchema.parse({
      default: "edit",
      editKey: "key",
      pinHash: null,
      requireApproval: false,
      nearby: true,
    });
    expect(participantPermissions(old)).toEqual({ rename: false, files: false, language: false });
  });
  it("never allows a toggle to override a viewer role or lock", () => {
    const allowed = { rename: true, files: true, language: true };
    for (const action of ["rename", "files", "language"] as const) {
      expect(canChangeDocument("view", false, allowed, action)).toBe(false);
      expect(canChangeDocument("edit", true, allowed, action)).toBe(false);
      expect(canChangeDocument("owner", true, allowed, action)).toBe(false);
      expect(canChangeDocument("owner", false, participantPermissions(), action)).toBe(true);
      expect(canChangeDocument("edit", false, allowed, action)).toBe(true);
    }
  });
});
