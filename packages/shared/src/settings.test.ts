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
      templates: [],
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
    expect(settingsSchema.safeParse({ maxDocBytes: 16 * 1024 * 1024 }).success).toBe(false);
  });

  describe("templates", () => {
    const template = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      name: "Team service",
      language: "typescript",
      description: "",
      files: [{ path: "src/index.ts", content: "export {};\n" }],
      ...overrides,
    });
    const parse = (templates: unknown[], extra: Record<string, unknown> = {}) =>
      settingsSchema.safeParse({ templates, ...extra });

    it("accepts up to 50 templates", () => {
      const many = Array.from({ length: 50 }, (_, i) => template(`org-${i}`));
      expect(parse(many).success).toBe(true);
      expect(parse([...many, template("org-50")]).success).toBe(false);
    });

    it("needs unique ids", () => {
      const result = parse([template("a"), template("b"), template("a")]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["templates", 2, "id"]);
    });

    it("refuses ids that could collide with built-in ones", () => {
      expect(parse([template("builtin-java")]).success).toBe(false);
      expect(parse([template("Builtin-x")]).success).toBe(false);
      expect(parse([template("my-builtin-java")]).success).toBe(true);
    });

    it("validates id, name, language, description and files", () => {
      expect(parse([template("bad id")]).success).toBe(false);
      expect(parse([template("x".repeat(41))]).success).toBe(false);
      expect(parse([template("a", { name: "  " })]).success).toBe(false);
      expect(parse([template("a", { name: "n".repeat(61) })]).success).toBe(false);
      expect(parse([template("a", { language: "" })]).success).toBe(false);
      expect(parse([template("a", { description: "d".repeat(201) })]).success).toBe(false);
      expect(parse([template("a", { files: [] })]).success).toBe(false);
    });

    it("refuses duplicate and unsafe file paths", () => {
      const file = (path: string) => ({ path, content: "" });
      expect(parse([template("a", { files: [file("a.py"), file("a.py")] })]).success).toBe(false);
      for (const path of [
        "../a.py",
        "/a.py",
        "a//b.py",
        "a\\b.py",
        "C:/a.py",
        "./a.py",
        "a\n.py",
      ]) {
        expect(parse([template("a", { files: [file(path)] })]).success, path).toBe(false);
      }
      expect(parse([template("a", { files: [file("pkg/a.py")] })]).success).toBe(true);
    });

    it("keeps each template within maxDocBytes", () => {
      const big = template("a", { files: [{ path: "a.txt", content: "x".repeat(2000) }] });
      expect(parse([big], { maxDocBytes: 1000 }).success).toBe(false);
      expect(parse([big], { maxDocBytes: 2000 }).success).toBe(true);
    });

    it("trims name and description", () => {
      const parsed = parse([template("a", { name: "  Team  ", description: " Hi " })]);
      expect(parsed.data?.templates[0]).toMatchObject({ name: "Team", description: "Hi" });
    });
  });
});
