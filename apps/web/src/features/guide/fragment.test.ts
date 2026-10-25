import { describe, expect, it } from "vitest";
import { fragmentId } from "./fragment";

describe("fragmentId", () => {
  it("reads the id with or without the leading #", () => {
    expect(fragmentId("#pin")).toBe("pin");
    expect(fragmentId("pin")).toBe("pin");
    expect(fragmentId("")).toBe("");
    expect(fragmentId("#")).toBe("");
  });

  it("decodes percent-encoding", () => {
    expect(fragmentId("#%EA%B0%80")).toBe("가");
  });

  it("ignores a fragment that is not valid percent-encoding", () => {
    expect(fragmentId("#%E0%A4%A")).toBe("");
    expect(fragmentId("#%")).toBe("");
    expect(fragmentId("#100%")).toBe("");
  });
});
