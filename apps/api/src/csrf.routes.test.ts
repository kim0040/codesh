import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

describe.skipIf(!integration)("cross-site request guard", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ config: { publicUrl: "https://gachipad.corp" } });
  });
  afterAll(() => h.close());

  /** What a cross-site form can do: a plain POST with an Origin and without custom headers. */
  const bare = (headers: Record<string, string> = {}) => ({
    headers: { "x-codesh": "", ...headers },
  });

  it("refuses changes without X-Codesh and without an Origin of our own", async () => {
    const client = h.client();
    const { id } = await createShare(client);
    for (const [method, url] of [
      ["POST", "/api/shares"],
      ["POST", `/api/shares/${id}/fork`],
      ["POST", "/api/auth/logout"],
      ["PATCH", `/api/shares/${id}`],
      ["DELETE", `/api/shares/${id}`],
    ] as const) {
      const foreign: Record<string, string>[] = [
        {},
        { origin: "https://evil.example" },
        { origin: "null" },
      ];
      for (const headers of foreign) {
        const response = await client.request(method, url, { body: {}, ...bare(headers) });
        expect(response.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(errorCode(response)).toBe("forbidden");
      }
    }
    // Nothing was deleted or created by the refused requests.
    expect((await client.get(`/api/shares/${id}`)).statusCode).toBe(200);
  });

  it("refuses a multipart upload posted from another site", async () => {
    const client = h.client();
    const form = new FormData();
    form.append("file", new Blob(["x"]), "a.txt");
    const encoded = new Response(form);
    const response = await client.request("POST", "/api/uploads", {
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: {
        "content-type": encoded.headers.get("content-type") as string,
        "x-codesh": "",
        origin: "https://evil.example",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("accepts X-Codesh: 1, and an Origin that is the app's own", async () => {
    const client = h.client();
    expect((await client.request("POST", "/api/shares", { body: {} })).statusCode).toBe(200);
    const sameHost = await client.request("POST", "/api/shares", {
      body: {},
      ...bare({ origin: "http://app.local:3001", host: "app.local:3001" }),
    });
    expect(sameHost.statusCode).toBe(200);
    const configured = await client.request("POST", "/api/shares", {
      body: {},
      ...bare({ origin: "https://gachipad.corp", host: "internal:3001" }),
    });
    expect(configured.statusCode).toBe(200);
  });

  it("never blocks reads, and leaves the bearer-token admin API alone", async () => {
    const client = h.client();
    expect((await client.get("/api/session")).statusCode).toBe(200);
    const { id } = await createShare(client);
    const read = await client.request("GET", `/api/shares/${id}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(read.statusCode).toBe(200);
    const admin = await client.request("PUT", "/api/admin/settings", {
      body: {},
      ...bare({ authorization: "Bearer wrong" }),
    });
    expect(admin.statusCode).toBe(403);
    expect(errorCode(admin)).toBe("forbidden");
    expect(admin.json<{ error: { message: string } }>().error.message).toBe("Invalid admin token");
  });
});
