import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { CollabServer } from "./server.js";
import { Harness, servicesAvailable } from "./testing/harness.js";

const available = await servicesAvailable();

describe.runIf(available)("collab server routes", () => {
  let harness: Harness;
  let server: CollabServer;

  beforeAll(async () => {
    harness = await Harness.create();
    server = await harness.startServer();
  });
  afterAll(() => harness?.close());

  const connect = (path: string) =>
    new Promise<"open" | "error">((resolve) => {
      const socket = new WebSocket(`${server.webSocketURL}${path}`);
      socket.on("open", () => {
        socket.close();
        resolve("open");
      });
      socket.on("error", () => resolve("error"));
    });

  it("answers GET /healthz", async () => {
    const response = await fetch(`${server.httpURL}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("exposes Prometheus metrics", async () => {
    const response = await fetch(`${server.httpURL}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const name of [
      "gachipad_collab_connections",
      "gachipad_collab_documents_loaded",
      "gachipad_collab_flush_seconds",
      "gachipad_collab_updates_total",
    ]) {
      expect(body).toContain(name);
    }
  });

  it("answers other HTTP paths with 404", async () => {
    expect((await fetch(`${server.httpURL}/`)).status).toBe(404);
  });

  it("accepts WebSocket connections on /collab only", async () => {
    expect(await connect("/collab?doc=abcd1234")).toBe("open");
    expect(await connect("/elsewhere")).toBe("error");
  });
});
