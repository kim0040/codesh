import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createCollabServer } from "./server.js";

describe("collab server", () => {
  const server = createCollabServer({ port: 0, address: "127.0.0.1", quiet: true });

  beforeAll(async () => {
    await server.listen();
  });
  afterAll(() => server.destroy());

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

  it("answers other HTTP paths with 404", async () => {
    expect((await fetch(`${server.httpURL}/`)).status).toBe(404);
  });

  it("accepts WebSocket connections on /collab only", async () => {
    expect(await connect("/collab?doc=abcd1234")).toBe("open");
    expect(await connect("/elsewhere")).toBe("error");
  });
});
