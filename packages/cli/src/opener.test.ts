import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Io, run } from "./run.js";

it.each([{ id: "a&calc.exe" }, { labId: "../../x" }, { id: "12345678" }])(
  "L12: refuses a server-supplied opener target %j",
  async (target) => {
    const dir = await mkdtemp(join(tmpdir(), "gachipad-opener-"));
    const openBrowser = vi.fn();
    const io: Io = {
      stdout: vi.fn(),
      stderr: vi.fn(),
      env: { GACHIPAD_URL: "http://localhost", GACHIPAD_CONFIG: join(dir, "config.json") },
      cwd: dir,
      readStdin: async () => Buffer.alloc(0),
      stdinIsTTY: true,
      openBrowser,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(target)),
    );
    try {
      expect(await run(["open", "123456"], io)).toBe(1);
      expect(openBrowser).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
