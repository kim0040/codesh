import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe("local diagnostics", () => {
  it("rehashes random session references independently for each export", async () => {
    const d = await import("./diagnostics");
    const ref = d.newDiagnosticReference();
    const at = new Date().toISOString();
    const events = [
      {
        kind: "connect" as const,
        source: "client" as const,
        level: "warn" as const,
        firstAt: at,
        lastAt: at,
        count: 1,
        details: { shareRef: ref },
      },
    ];
    const first = d.diagnosticExportEvents(events);
    const second = d.diagnosticExportEvents(events);
    expect(first[0]?.details.shareRef).toMatch(/^[a-f0-9]{16}$/);
    expect(first[0]?.details.shareRef).not.toBe(ref);
    expect(first[0]?.details.shareRef).not.toBe(second[0]?.details.shareRef);
  });
  it("works in memory when all storage access throws, and obeys off and clear", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const d = await import("./diagnostics");
    d.recordDiagnostic("api_failure", { route: "/api/shares/Abcd1234?pin=1234", status: 500 });
    expect(d.diagnosticsState()).toEqual({ enabled: true, count: 1 });
    d.setDiagnosticsEnabled(false);
    d.recordDiagnostic("disconnect");
    expect(d.diagnosticsState().count).toBe(1);
    d.clearDiagnostics();
    expect(d.diagnosticsState()).toEqual({ enabled: false, count: 0 });
  });
  it("loads scrubbed storage, persists and prunes safely", async () => {
    const values = new Map<string, string>();
    const at = new Date().toISOString();
    values.set(
      "codesh.diagnostics.v1",
      JSON.stringify([
        {
          source: "client",
          kind: "api_failure",
          level: "error",
          firstAt: at,
          lastAt: at,
          count: 1,
          details: {
            body: "DOCUMENT_PRIVATE",
            token: "TOKEN_PRIVATE",
            route: "/api/shares/Abcd1234#key=PRIVATE",
          },
        },
      ]),
    );
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, v: string) => values.set(key, v),
      removeItem: (key: string) => values.delete(key),
    });
    const d = await import("./diagnostics");
    expect(d.diagnosticsState().count).toBe(1);
    d.clearDiagnostics();
    expect(values.has("codesh.diagnostics.v1")).toBe(false);
  });
});
