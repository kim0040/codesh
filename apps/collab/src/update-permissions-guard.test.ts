import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Collab } from "./collab.js";

describe("beforeSync document state", () => {
  it("fails closed when a content update has no loaded state", async () => {
    const collab = new Collab({} as ConstructorParameters<typeof Collab>[0]);
    const doc = Object.assign(new Y.Doc(), { name: "missing" });
    const connection = { readOnly: false, close: vi.fn() };
    await collab.beforeSync({
      connection,
      document: doc,
      type: 2,
      payload: new Uint8Array(),
    } as unknown as Parameters<Collab["beforeSync"]>[0]);
    expect(connection.readOnly).toBe(true);
    expect(connection.close).toHaveBeenCalledWith({
      code: 4401,
      reason: "Document state unavailable",
    });
    doc.destroy();
  });
});
