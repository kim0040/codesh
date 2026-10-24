import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, Harness, servicesAvailable, waitFor } from "./testing/harness.js";

const available = await servicesAvailable();

describe.runIf(available)("broadcast window of a busy document", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await Harness.create();
  });
  afterAll(() => harness?.close());

  it("sends edits at once, batches cursor-only changes and stops below the threshold", async () => {
    const server = await harness.startServer({
      timings: { broadcastWindowMs: 300, broadcastWindowFrom: 3 },
    });
    const share = await harness.createShare();
    const clients: Client[] = [];
    for (let i = 0; i < 3; i++) {
      const client = await harness.connect(server.webSocketURL, share.id);
      await client.synced;
      clients.push(client);
    }
    const [a, b, c] = clients as [Client, Client, Client];
    const document = server.collab.docs.get(share.id)?.document;
    await waitFor(() => document?.flushDelay === 300, "window on");

    let started = Date.now();
    a.text.insert(0, "x");
    await waitFor(() => b.text.toString() === "x", "the edit");
    expect(Date.now() - started).toBeLessThan(200);

    const awareness = a.provider.awareness;
    if (!awareness) throw new Error("no awareness");
    started = Date.now();
    awareness.setLocalStateField("fileId", "batched");
    await waitFor(
      () =>
        (b.provider.awareness?.getStates().get(awareness.clientID) as { fileId?: string })
          ?.fileId === "batched",
      "the cursor-only change",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    c.destroy();
    await waitFor(() => document?.flushDelay === 0, "window off");
  });
});
