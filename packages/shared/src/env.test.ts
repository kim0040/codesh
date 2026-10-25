import { expect, it, vi } from "vitest";
import { renamedEnv } from "./env.js";

// legacy codesh name (1.0.x); remove in 2.0
it("prefers the new env name and warns once when using a legacy fallback", () => {
  const warn = vi.fn();
  expect(renamedEnv({ GACHIPAD_NS: "new:", CODESH_NS: "old:" }, "GACHIPAD_NS", warn)).toBe("new:");
  expect(warn).not.toHaveBeenCalled();
  expect(renamedEnv({ CODESH_NS: "old:" }, "GACHIPAD_NS", warn)).toBe("old:");
  expect(renamedEnv({ CODESH_NS: "old:" }, "GACHIPAD_NS", warn)).toBe("old:");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(renamedEnv({}, "GACHIPAD_NS", warn)).toBeUndefined();
});
