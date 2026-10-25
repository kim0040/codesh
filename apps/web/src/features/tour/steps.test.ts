import { dictionaries } from "@gachipad/i18n";
import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "./steps";

describe("TOUR_STEPS", () => {
  it("has four to six steps, each pointing at a different element", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(4);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(6);
    expect(new Set(TOUR_STEPS.map((step) => step.id)).size).toBe(TOUR_STEPS.length);
  });

  it("has a title and a body in both languages for every step", () => {
    for (const locale of ["en", "ko"] as const) {
      const dictionary: Record<string, string> = dictionaries[locale];
      for (const step of TOUR_STEPS) {
        expect(dictionary[step.title], `${locale} ${step.title}`).toBeTruthy();
        expect(dictionary[step.body], `${locale} ${step.body}`).toBeTruthy();
      }
    }
  });
});
