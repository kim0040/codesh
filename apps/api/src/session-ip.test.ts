import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "./ctx.js";
import { parseCidrs } from "./net.js";
import { clientIp } from "./session.js";

describe("public client identity warnings", () => {
  it("warns without raw addresses once per minute for missing, malformed and trusted-only forwarding", () => {
    const ctx = {
      config: { network: "public" },
      trusted: parseCidrs(["127.0.0.1/32", "172.29.88.0/24"]),
      unknownClientWarningAt: 0,
      diagnostics: { recordClientIdentity: vi.fn(), record: vi.fn() },
    } as unknown as Ctx;
    const warn = vi.fn();
    const request = (forwarded?: string) =>
      ({
        ip: "127.0.0.1",
        headers: { "x-forwarded-for": forwarded },
        log: { warn },
      }) as unknown as FastifyRequest;
    const clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
    try {
      for (const forwarded of [undefined, "172.29.88.1", "bad", "127.0.0.1"])
        expect(clientIp(ctx, request(forwarded))).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(ctx.diagnostics.record).toHaveBeenCalledWith("client_identity_unknown");
      expect(warn.mock.calls[0]?.[0]).toMatch(/Docker.*IPv6.*X-Forwarded-For/);
      expect(warn.mock.calls[0]?.[0]).not.toMatch(/127\.0\.0\.1|172\.29\.88\.1/);
      clock.mockReturnValue(120_000);
      expect(clientIp(ctx, request())).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(clientIp(ctx, request("198.51.100.8"))).toBe("198.51.100.8");
      const cached = request();
      clientIp(ctx, cached);
      const calls = vi.mocked(ctx.diagnostics.recordClientIdentity).mock.calls.length;
      clientIp(ctx, cached);
      expect(ctx.diagnostics.recordClientIdentity).toHaveBeenCalledTimes(calls);
    } finally {
      clock.mockRestore();
    }
  });
});
