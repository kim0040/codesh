import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CAPS,
  DiagnosticRing,
  diagnosticError,
  diagnosticLocation,
  diagnosticRoute,
  scrubDiagnosticDetails,
} from "./diagnostics.js";

describe("diagnostic privacy", () => {
  const secret = "NEVER-export-editor-text-pin-482913-key-token@example.test";
  it("keeps route patterns and discards every query, fragment, code and id", () => {
    expect(diagnosticRoute(`/api/shares/Abcd1234/join?pin=${secret}#key=${secret}`)).toBe(
      "/api/shares/:id/join",
    );
    expect(diagnosticRoute("/api/shares/security/join")).toBe("/api/shares/:id/join");
    expect(diagnosticRoute("/api/admin/shares/settings/delete")).toBe(
      "/api/admin/shares/:id/delete",
    );
    expect(diagnosticRoute("/api/codes/123456")).toBe("/api/codes/:id");
    expect(diagnosticRoute(`https://host.test/${secret}`)).toBe(":route");
    expect(diagnosticRoute(`/api/${secret}`)).not.toContain(secret);
  });
  it("accepts only operational fields and safe error categories", () => {
    const result = scrubDiagnosticDetails({
      body: secret,
      token: secret,
      cookie: secret,
      email: secret,
      fileName: secret,
      shareId: secret,
      message: secret,
      reason: secret,
      code: secret,
      route: `/api/shares/${secret}?key=${secret}`,
      durationMs: 300,
      status: 503,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      status: 503,
      durationMs: 300,
      route: "/api/shares/:id",
      message: "Error (text omitted)",
      reason: "abnormal",
      code: "unknown",
    });
  });
  it("keeps source line/column while removing arbitrary message, function names and URL secrets", () => {
    const error = new Error(secret);
    error.stack = `Error: ${secret}\n    at ${secret} (https://private.test/assets/app-123.js:2:17?key=${secret})\n    at https://private.test/src/lib/api.ts:42:3\n    at ${secret} (file:///${secret}.txt:9:2)`;
    const result = diagnosticError(error);
    expect(result.message).toBe("Error (text omitted)");
    expect(result.stack).toContain("/src/lib/api.ts:42:3");
    expect(JSON.stringify(result)).not.toMatch(/private\.test|key=|NEVER-export/);
    expect(diagnosticLocation(`https://host.test/${secret}`)).toBe("[source omitted]");
    expect(diagnosticError(secret)).toEqual({ message: "Non-Error rejection (text omitted)" });
  });
});
describe("bounded diagnostic ring", () => {
  it("deduplicates a loop, preserves a different event and tracks worst duration", () => {
    let now = Date.now();
    const ring = new DiagnosticRing(() => now);
    ring.record("client", "render", {}, "error");
    for (let i = 0; i < 1200; i++) {
      now++;
      ring.record("client", "api_failure", { route: "/api/shares/Abcd1234", durationMs: i });
    }
    expect(ring.list()).toHaveLength(2);
    expect(ring.list()[1]).toMatchObject({
      count: 1200,
      details: { worstMs: 1199, route: "/api/shares/:id" },
    });
    expect(ring.list()[1]?.firstAt).not.toBe(ring.list()[1]?.lastAt);
  });
  it("expires stale records and caps count and UTF-8 bytes", () => {
    let now = Date.now();
    const ring = new DiagnosticRing(() => now);
    for (let i = 0; i < 1000; i++)
      ring.record("api", "response_5xx", {
        status: i,
        stack: Array(12)
          .fill(`/src/lib/${"a".repeat(150)}.ts:1:2`)
          .join("\n"),
      });
    expect(ring.list().length).toBeLessThanOrEqual(DIAGNOSTIC_CAPS.events);
    expect(new TextEncoder().encode(JSON.stringify(ring.list())).byteLength).toBeLessThanOrEqual(
      DIAGNOSTIC_CAPS.bytes,
    );
    now += 15 * 86400_000;
    expect(ring.list()).toEqual([]);
  });
  it("scrubs forged persisted records and rejects malformed data", () => {
    const ring = new DiagnosticRing();
    ring.load([
      {
        kind: "api_failure",
        source: "client",
        level: "error",
        firstAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        count: -4,
        details: { token: "secret", message: "typed document text" },
      },
      { kind: "invalid" },
      null,
    ]);
    expect(ring.list()).toHaveLength(1);
    expect(ring.list()[0]).toMatchObject({
      count: 1,
      details: { message: "Error (text omitted)" },
    });
    expect(JSON.stringify(ring.list())).not.toMatch(/secret|typed document/);
  });
});
