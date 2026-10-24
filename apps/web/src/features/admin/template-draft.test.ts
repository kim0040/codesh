import { MAX_TEMPLATES_TOTAL_BYTES, type SettingsTemplate } from "@codesh/shared";
import { describe, expect, it } from "vitest";
import { toDraft, validate } from "./template-draft";

// Messages are replaced by their keys, which is enough to tell them apart.
const t = ((key: string) => key) as Parameters<typeof validate>[3];

const stored: SettingsTemplate = {
  id: "org-a",
  name: "Team service",
  language: "go",
  description: "",
  files: [
    { path: "main.go", language: "go", content: "package main\n" },
    { path: "README.md", content: "# Team\n" },
  ],
};

describe("template draft", () => {
  it("keeps the language of each file through an edit", () => {
    const result = validate(toDraft(stored), 5_000_000, 0, t);
    expect(result).toEqual({ template: stored });
  });

  it("says so when the id is not valid, since the form has no field for it", () => {
    const result = validate({ ...toDraft(stored), id: "builtin-java" }, 5_000_000, 0, t);
    expect("errors" in result && result.errors.form).toBe("admin.template.error.id");
    const spaced = validate({ ...toDraft(stored), id: "has space" }, 5_000_000, 0, t);
    expect("errors" in spaced && spaced.errors.form).toBe("admin.template.error.id");
  });

  it("refuses a template that would take the templates over the total limit", () => {
    const draft = toDraft({
      ...stored,
      files: [{ path: "a.txt", content: "x".repeat(1000) }],
    });
    expect(validate(draft, 5_000_000, MAX_TEMPLATES_TOTAL_BYTES - 1000, t)).toHaveProperty(
      "template",
    );
    const over = validate(draft, 5_000_000, MAX_TEMPLATES_TOTAL_BYTES - 999, t);
    expect("errors" in over && over.errors.files).toBe("admin.template.error.total");
  });

  it("reports the size of one template against maxDocBytes first", () => {
    const over = validate(toDraft(stored), 10, 0, t);
    expect("errors" in over && over.errors.files).toBe("admin.template.error.size");
  });
});
