import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CAPS,
  DiagnosticRing,
  diagnosticCountBucket,
  diagnosticError,
  diagnosticLocation,
  diagnosticRoute,
  diagnosticSizeBucket,
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
  it("keeps engine messages whose only variable parts are names in the code", () => {
    const kept = [
      [new TypeError("Cannot read properties of undefined (reading 'state')"), "TypeError"],
      [new TypeError("Cannot set properties of null (setting 'value')"), "TypeError"],
      [new TypeError('can\'t access property "name", a is undefined'), "TypeError"],
      [new TypeError("view.dispatch is not a function"), "TypeError"],
      [new TypeError("undefined is not an object (evaluating 'state.field')"), "TypeError"],
      [new ReferenceError("Cannot access 'x' before initialization"), "ReferenceError"],
      [new RangeError("Maximum call stack size exceeded"), "RangeError"],
      [
        Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" }),
        "QuotaExceededError",
      ],
    ] as const;
    for (const [error, name] of kept) {
      const { message } = diagnosticError(error);
      expect(message).toContain(`${name}:`);
      expect(message).not.toContain("'state'");
      expect(message).not.toContain('"name"');
      expect(scrubDiagnosticDetails({ message }).message).toBe(message);
    }
    expect(
      diagnosticError(new TypeError("Cannot read properties of undefined (reading 'state')"))
        .message,
    ).toBe("TypeError: Cannot read properties of undefined (reading '<prop>')");
    expect(
      diagnosticError(new TypeError("undefined is not an object (evaluating 'state.field')"))
        .message,
    ).toBe("TypeError: undefined is not an object (evaluating '<prop>')");
  });
  it("never retains runtime property keys, including file-like names, from old or new records", () => {
    for (const key of ["kT3x9QpA", "readme.md", "main.py", "a.b.c"]) {
      const messages = [
        `Cannot read properties of undefined (reading '${key}')`,
        `Cannot set properties of null (setting '${key}')`,
        `can't access property "${key}", target is undefined`,
        `undefined is not an object (evaluating 'target.${key}')`,
      ];
      for (const text of messages) {
        const safe = diagnosticError(new TypeError(text)).message ?? "";
        expect(safe).not.toContain(key);
        expect(scrubDiagnosticDetails({ message: safe }).message).not.toContain(key);
      }
      const old = scrubDiagnosticDetails({
        message: `TypeError: Cannot read properties of undefined (reading '${key}')`,
      }).message;
      expect(old).not.toContain(key);
      expect(old).toContain("<prop>");
    }
  });
  it("keeps the throwing frame for V8, SpiderMonkey, and JavaScriptCore stacks", () => {
    const stacks = [
      "TypeError: failed\n    at boom (https://private.test/assets/app.js:2:3)",
      "TypeError: failed\nboom@https://private.test/src/client.ts:4:5",
      "TypeError: failed\nglobal code@https://private.test/assets/app.js:6:7",
    ];
    const expected = ["/assets/app.js:2:3", "/src/client.ts:4:5", "/assets/app.js:6:7"];
    stacks.forEach((stack, index) => {
      const details = diagnosticError(Object.assign(new TypeError("failed"), { stack }));
      expect(details.stack).toContain(expected[index]);
    });
  });
  it("keeps only allowlisted network and numeric error codes", () => {
    expect(
      diagnosticError(Object.assign(new Error("failed"), { code: "EAI_AGAIN" })),
    ).toMatchObject({
      code: "EAI_AGAIN",
    });
    expect(diagnosticError(Object.assign(new Error("failed"), { code: 91_234 }))).toMatchObject({
      errorCode: 91_234,
    });
    expect(
      diagnosticError(Object.assign(new Error("secret"), { code: "SECRET_VALUE" })),
    ).not.toHaveProperty("code");
  });
  it("omits messages that quote text, even inside a known template's shape", () => {
    for (const text of [
      `Unexpected token 'N', "${secret}" is not valid JSON`,
      "my password 482913 is not defined",
      `${"a".repeat(300)} is not a function`,
      "x is not a function\nsecond line with editor text",
    ]) {
      const { message } = diagnosticError(new SyntaxError(text));
      expect(message).toBe("SyntaxError (text omitted)");
    }
    const property = diagnosticError(
      new TypeError(`Cannot read properties of undefined (reading '${secret}')`),
    ).message;
    expect(property).toContain("<prop>");
    expect(property).not.toContain(secret);
    expect(scrubDiagnosticDetails({ message: `TypeError: ${secret}` }).message).toBe(
      "Error (text omitted)",
    );
    expect(scrubDiagnosticDetails({ message: "Evil (text omitted)" }).message).toBe(
      "Error (text omitted)",
    );
  });
});
describe("bounded diagnostic ring", () => {
  it("keeps slow-operation context in coarse buckets", () => {
    expect([0, 64 * 1024, 1024 * 1024, 10 * 1024 * 1024].map(diagnosticSizeBucket)).toEqual([
      "lt_64k",
      "64k_1m",
      "1m_10m",
      "gte_10m",
    ]);
    expect([0, 1, 2, 6, 21].map(diagnosticCountBucket)).toEqual([
      "0",
      "1",
      "2_5",
      "6_20",
      "gte_21",
    ]);
    const ring = new DiagnosticRing();
    for (const kind of ["slow_sync", "long_task", "slow_flush"] as const)
      ring.record("client", kind, {
        durationMs: 6000,
        documentSize: diagnosticSizeBucket(700_000),
        fileCount: diagnosticCountBucket(4),
        connectionCount: diagnosticCountBucket(8),
      });
    expect(ring.list().map((event) => event.details)).toEqual(
      Array.from({ length: 3 }, () => ({
        durationMs: 6000,
        documentSize: "64k_1m",
        fileCount: "2_5",
        connectionCount: "6_20",
      })),
    );
  });
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
  it("does not invent a worst duration and evicts by lastAt", () => {
    let now = Date.now();
    const ring = new DiagnosticRing(() => now);
    ring.record("api", "mongo_error", {}, "error");
    expect(ring.list()[0]?.details).not.toHaveProperty("worstMs");
    for (let status = 1; status < DIAGNOSTIC_CAPS.events; status++) {
      now++;
      ring.record("api", "api_failure", { status });
    }
    now += 100;
    ring.record("api", "api_failure", { status: 1 });
    now++;
    ring.record("api", "api_failure", { status: DIAGNOSTIC_CAPS.events });
    expect(ring.list().some((event) => event.details.status === 1)).toBe(true);
    expect(ring.list().some((event) => event.kind === "mongo_error")).toBe(false);
  });
  it("keeps record cost bounded with a full ring", () => {
    const ring = new DiagnosticRing();
    for (let status = 0; status < DIAGNOSTIC_CAPS.events; status++)
      ring.record("api", "api_failure", { status });
    const started = performance.now();
    for (let i = 0; i < 1000; i++) ring.record("api", "api_failure", { status: 900 });
    expect(performance.now() - started).toBeLessThan(250);
    expect(ring.count).toBe(DIAGNOSTIC_CAPS.events);
  });
  it("stores only a short status and code breadcrumb timeline", () => {
    let now = Date.now();
    const ring = new DiagnosticRing(() => now);
    for (let index = 0; index < 60; index++) {
      now++;
      ring.record("api", "api_failure", {
        status: 503,
        code: "ECONNRESET",
        message: `secret-${index}`,
      });
    }
    const crumbs = ring.listBreadcrumbs();
    expect(crumbs).toHaveLength(50);
    expect(crumbs[0]).toMatchObject({ kind: "api_failure", status: 503, code: "ECONNRESET" });
    expect(JSON.stringify(crumbs)).not.toContain("secret-");
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
