import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { errorText } from "./errors";

describe("errorText", () => {
  it("maps API error codes to message keys", () => {
    expect(errorText(new ApiError(404, "not_found", "x", null))).toEqual({
      title: "error.not_found",
      hint: "error.not_found.hint",
    });
    expect(errorText(new ApiError(0, "network", "x", null)).title).toBe("error.network");
  });

  it("treats anything else as a generic error", () => {
    expect(errorText(new Error("boom")).title).toBe("error.generic");
    expect(errorText("nope").title).toBe("error.generic");
  });
});
