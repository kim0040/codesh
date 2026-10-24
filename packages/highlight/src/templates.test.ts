import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "../../shared/src/templates.js";
import { getLanguage, languageForFilename } from "./languages.js";

describe("built-in code templates", () => {
  it("use languages of the registry", () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(getLanguage(template.language), `${template.id}: ${template.language}`).toBeDefined();
      for (const file of template.files) {
        if (file.language) {
          expect(getLanguage(file.language), `${template.id}/${file.path}`).toBeDefined();
        }
      }
    }
  });

  it("have file names the registry highlights with the template's language", () => {
    for (const template of BUILTIN_TEMPLATES) {
      const [first] = template.files;
      const detected = languageForFilename(first?.path ?? "")?.id;
      // The HTML page starts with index.html; every other template starts with its own language.
      expect(detected, `${template.id}/${first?.path}`).toBe(template.language);
    }
  });

  it("highlight every file by its extension", () => {
    for (const template of BUILTIN_TEMPLATES) {
      for (const file of template.files) {
        const language = file.language ?? languageForFilename(file.path)?.id;
        expect(language, `${template.id}/${file.path}`).toBeDefined();
        expect(language, `${template.id}/${file.path}`).not.toBe("plaintext");
      }
    }
  });
});
