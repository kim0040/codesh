import { describe, expect, it } from "vitest";
import { defaultSettings, settingsSchema } from "./settings.js";

describe("settings defaults", () => {
  it("match ARCHITECTURE §10", () => {
    expect(defaultSettings()).toEqual({
      anonymousTtlHours: 24,
      historyRetentionDays: 7,
      maxDocBytes: 5 * 1024 * 1024,
      maxUploadMB: 200,
      guestAllowed: true,
      rooms: [],
      subnetPrefixV4: 24,
      nearbyDefault: true,
      audit: { enabled: false, retentionDays: 90 },
      secretWarning: true,
      auth: { oidc: null, ldap: null },
      contact: "",
    });
  });

  it("fills nested defaults for partial input", () => {
    const settings = settingsSchema.parse({ audit: { enabled: true } });
    expect(settings.audit).toEqual({ enabled: true, retentionDays: 90 });
  });

  it("returns independent objects", () => {
    const a = defaultSettings();
    a.rooms.push({ name: "lab 1", cidrs: ["10.0.1.0/24"] });
    expect(defaultSettings().rooms).toEqual([]);
  });

  it("rejects out-of-range values", () => {
    expect(settingsSchema.safeParse({ subnetPrefixV4: 4 }).success).toBe(false);
    expect(settingsSchema.safeParse({ anonymousTtlHours: 0 }).success).toBe(false);
  });
});
