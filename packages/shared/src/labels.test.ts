import { describe, expect, it } from "vitest";
import { hasLabels, putLabelsBodySchema } from "./labels.js";

const parse = (body: unknown) => putLabelsBodySchema.safeParse(body);

describe("putLabelsBodySchema", () => {
  it("trims the folder and the tags", () => {
    expect(parse({ folder: "  Week 1 ", tags: [" loops ", "java"] }).data).toEqual({
      folder: "Week 1",
      tags: ["loops", "java"],
    });
  });

  it("treats an empty folder as no folder", () => {
    expect(parse({ folder: "", tags: [] }).data?.folder).toBeNull();
    expect(parse({ folder: "   ", tags: [] }).data?.folder).toBeNull();
    expect(parse({ folder: null, tags: [] }).data?.folder).toBeNull();
  });

  it("limits the folder to 60 characters", () => {
    expect(parse({ folder: "f".repeat(60), tags: [] }).success).toBe(true);
    expect(parse({ folder: "f".repeat(61), tags: [] }).success).toBe(false);
  });

  it("limits a tag to 1-30 characters", () => {
    expect(parse({ folder: null, tags: ["t".repeat(30)] }).success).toBe(true);
    expect(parse({ folder: null, tags: ["t".repeat(31)] }).success).toBe(false);
    expect(parse({ folder: null, tags: ["  "] }).success).toBe(false);
  });

  it("allows at most 10 tags, counted after duplicates are removed", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    expect(parse({ folder: null, tags: ten }).success).toBe(true);
    expect(parse({ folder: null, tags: [...ten, "tag10"] }).success).toBe(false);
    expect(parse({ folder: null, tags: [...ten, "TAG0"] }).data?.tags).toEqual(ten);
    expect(
      parse({ folder: null, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success,
    ).toBe(false);
  });

  it("removes duplicates case-insensitively and keeps the first spelling", () => {
    expect(parse({ folder: null, tags: ["Java", "java", "JAVA", "loops"] }).data?.tags).toEqual([
      "Java",
      "loops",
    ]);
  });

  it("refuses control characters and missing fields", () => {
    expect(parse({ folder: "a\nb", tags: [] }).success).toBe(false);
    expect(parse({ folder: null, tags: ["a\tb"] }).success).toBe(false);
    expect(parse({ folder: null }).success).toBe(false);
    expect(parse({ tags: [] }).success).toBe(false);
  });
});

describe("hasLabels", () => {
  it("is false only for no folder and no tags", () => {
    expect(hasLabels({ folder: null, tags: [] })).toBe(false);
    expect(hasLabels({ folder: "a", tags: [] })).toBe(true);
    expect(hasLabels({ folder: null, tags: ["a"] })).toBe(true);
  });
});
