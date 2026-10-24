import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATE_PREFIX } from "./constants.js";
import {
  BUILTIN_TEMPLATES,
  builtinTemplates,
  isPlainTemplatePath,
  listTemplatesResponseSchema,
  settingsTemplateSchema,
  templateBytes,
} from "./templates.js";

const LANGUAGES_REQUIRED = [
  "java",
  "python",
  "javascript",
  "typescript",
  "go",
  "rust",
  "c",
  "cpp",
  "csharp",
  "kotlin",
  "swift",
  "sql",
  "html",
  "markdown",
  "shell",
];

describe("built-in templates", () => {
  it("cover the languages people start with, and a multi-file project", () => {
    const languages = new Set(BUILTIN_TEMPLATES.map((template) => template.language));
    for (const language of LANGUAGES_REQUIRED) expect(languages.has(language), language).toBe(true);
    expect(BUILTIN_TEMPLATES.some((template) => template.files.length >= 3)).toBe(true);
  });

  it("have unique ids that start with the reserved prefix", () => {
    const ids = BUILTIN_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(BUILTIN_TEMPLATE_PREFIX), id).toBe(true);
  });

  it("store i18n keys named after their id, never text", () => {
    for (const template of BUILTIN_TEMPLATES) {
      const slug = template.id.slice(BUILTIN_TEMPLATE_PREFIX.length);
      expect(template.nameKey).toBe(`template.${slug}.name`);
      expect(template.descriptionKey).toBe(`template.${slug}.description`);
    }
  });

  it("hold valid, unique, non-empty files that fit a share", () => {
    for (const template of BUILTIN_TEMPLATES) {
      const paths = template.files.map((file) => file.path);
      expect(new Set(paths).size, template.id).toBe(paths.length);
      for (const file of template.files) {
        expect(isPlainTemplatePath(file.path), `${template.id}/${file.path}`).toBe(true);
        expect(file.content.trim(), `${template.id}/${file.path}`).not.toBe("");
        expect(file.content.endsWith("\n"), `${template.id}/${file.path}`).toBe(true);
      }
      expect(templateBytes(template.files), template.id).toBeLessThan(5 * 1024);
    }
  });

  it("start with the file the language is known for", () => {
    const first = (slug: string) => BUILTIN_TEMPLATES.find((t) => t.id.endsWith(slug))?.files[0];
    expect(first("-java")?.path).toBe("Main.java");
    expect(first("-python")?.content).toContain('if __name__ == "__main__":');
    expect(first("-web")?.path).toBe("index.html");
  });

  it("serialize in the shape of GET /api/templates", () => {
    const list = builtinTemplates();
    expect(listTemplatesResponseSchema.safeParse(list).success).toBe(true);
    expect(list.every((template) => template.builtin)).toBe(true);
    expect(list[0]?.name).toBe(BUILTIN_TEMPLATES[0]?.nameKey);
    // The copies may be changed without touching the built-ins.
    list[0]?.files.push({ path: "x", content: "" });
    expect(builtinTemplates()[0]?.files).toHaveLength(BUILTIN_TEMPLATES[0]?.files.length ?? 0);
  });

  it("can not be saved as settings templates (reserved ids)", () => {
    const first = builtinTemplates()[0];
    expect(settingsTemplateSchema.safeParse({ ...first, name: "x" }).success).toBe(false);
  });
});
