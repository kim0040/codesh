import { COLLAB_DENY_REASONS, generateClientId, PERMISSION_APPLY_MS } from "@codesh/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CollabServer } from "./server.js";
import {
  type Client,
  Harness,
  servicesAvailable,
  sleep,
  storedText,
  waitFor,
} from "./testing/harness.js";

const available = await servicesAvailable();

/** Milliseconds until `condition` holds, polling every millisecond. */
async function elapsedUntil(condition: () => boolean, label: string): Promise<number> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await sleep(1);
  }
  return performance.now() - started;
}

describe.runIf(available)("collab permissions", () => {
  let harness: Harness;
  let server: CollabServer;
  let version = 0;

  beforeAll(async () => {
    harness = await Harness.create();
    server = await harness.startServer();
  });
  afterAll(() => harness?.close());

  async function room(roles: Array<"owner" | "edit" | "view">) {
    const share = await harness.createShare();
    const clients: Client[] = [];
    for (const role of roles) {
      clients.push(await harness.connect(server.webSocketURL, share.id, { role }));
    }
    await Promise.all(clients.map((c) => c.synced));
    return { share, clients };
  }

  it("refuses bad, expired and foreign tokens, banned clients and missing shares", async () => {
    const share = await harness.createShare();
    const other = await harness.createShare();
    const banned = generateClientId();
    await harness.stores.shares.addBan(share.id, banned);
    const attempts = {
      garbage: harness.connect(server.webSocketURL, share.id, { token: "not-a-token" }),
      expired: harness
        .token(share.id, "edit", undefined, Math.floor(Date.now() / 1000) - 1)
        .then((token) => harness.connect(server.webSocketURL, share.id, { token })),
      foreign: harness
        .token(other.id, "edit")
        .then((token) => harness.connect(server.webSocketURL, share.id, { token })),
      banned: harness.connect(server.webSocketURL, share.id, { clientId: banned }),
      missing: harness.connect(server.webSocketURL, "zzzz9999"),
    };
    const reasons = Object.fromEntries(
      await Promise.all(
        Object.entries(attempts).map(async ([name, client]) => [name, await (await client).denied]),
      ),
    );
    expect(reasons).toEqual({
      garbage: COLLAB_DENY_REASONS.unauthorized,
      expired: COLLAB_DENY_REASONS.unauthorized,
      foreign: COLLAB_DENY_REASONS.unauthorized,
      banned: COLLAB_DENY_REASONS.banned,
      missing: COLLAB_DENY_REASONS.notFound,
    });
  });

  it("rejects updates from viewers", async () => {
    const {
      share,
      clients: [editor, viewer],
    } = await room(["edit", "view"]);
    if (!editor || !viewer) throw new Error("clients missing");
    editor.text.insert(0, "editor;");
    await waitFor(() => viewer.text.toString() === "editor;", "viewer receives edits");
    viewer.text.insert(0, "viewer;");
    await sleep(300);
    expect(editor.text.toString()).toBe("editor;");
    expect(server.collab.docs.get(share.id)?.document.getText("file:main").toString()).toBe(
      "editor;",
    );
    expect(await storedText(harness.stores, share.id)).toBe("editor;");
  });

  it(`closes a kicked client within ${PERMISSION_APPLY_MS} ms and leaves the others`, async () => {
    const {
      share,
      clients: [owner, kicked],
    } = await room(["owner", "edit"]);
    if (!owner || !kicked) throw new Error("clients missing");
    await harness.publishPerm(share.id, {
      version: ++version,
      kind: "kick",
      clientId: kicked.clientId,
    });
    const ms = await elapsedUntil(() => kicked.closes.includes("kicked"), "kick");
    expect(ms).toBeLessThan(PERMISSION_APPLY_MS);
    expect(owner.closes).toEqual([]);
    owner.text.insert(0, "still here");
    await waitFor(
      () =>
        server.collab.docs.get(share.id)?.document.getText("file:main").toString() === "still here",
      "owner keeps editing",
    );
  });

  it(`switches readOnly on a role change within ${PERMISSION_APPLY_MS} ms`, async () => {
    const {
      share,
      clients: [owner, member, other],
    } = await room(["owner", "edit", "edit"]);
    if (!owner || !member || !other) throw new Error("clients missing");
    owner.text.insert(0, "base;");
    await waitFor(() => member.text.toString() === "base;", "member synced");
    const role = (clientId: string, next: "edit" | "view") =>
      harness.publishPerm(share.id, { version: ++version, kind: "role", clientId, role: next });

    await role(member.clientId, "view");
    const ms = await elapsedUntil(() => member.stateless.length > 0, "role notice");
    expect(ms).toBeLessThan(PERMISSION_APPLY_MS);
    expect(member.stateless).toEqual([{ type: "role", role: "view", readOnly: true }]);
    member.text.insert(0, "blocked;");
    await sleep(300);
    expect(owner.text.toString()).toBe("base;");
    expect(other.stateless).toEqual([]);

    // Down and up again; a client that did not type meanwhile edits normally afterwards.
    await role(other.clientId, "view");
    await waitFor(() => other.stateless.length === 1, "other demoted");
    await role(other.clientId, "edit");
    await waitFor(() => other.stateless.length === 2, "other promoted");
    expect(other.stateless[1]).toEqual({ type: "role", role: "edit", readOnly: false });
    other.text.insert(other.text.length, "allowed;");
    await waitFor(() => owner.text.toString() === "base;allowed;", "edits apply again");
  });

  it("asks non-owners to rejoin when access changed without a per-client role", async () => {
    const {
      share,
      clients: [owner, member],
    } = await room(["owner", "edit"]);
    if (!owner || !member) throw new Error("clients missing");
    await harness.publishPerm(share.id, { version: ++version, kind: "role" });
    await waitFor(() => member.closes.includes("reauth"), "reauth close");
    expect(owner.closes).toEqual([]);
  });

  it("makes everyone but the owner read-only while the share is locked", async () => {
    const {
      share,
      clients: [owner, member],
    } = await room(["owner", "edit"]);
    if (!owner || !member) throw new Error("clients missing");
    await harness.stores.shares.update(share.id, { locked: true });
    await harness.publishPerm(share.id, { version: ++version, kind: "lock" });
    await waitFor(() => member.stateless.length > 0 && owner.stateless.length > 0, "lock notices");
    expect(member.stateless).toEqual([{ type: "locked", locked: true, readOnly: true }]);
    expect(owner.stateless).toEqual([{ type: "locked", locked: true, readOnly: false }]);

    member.text.insert(0, "member;");
    owner.text.insert(0, "owner;");
    await sleep(300);
    expect(await storedText(harness.stores, share.id)).toBe("owner;");

    // A client joining while locked is read-only from the start.
    const late = await harness.connect(server.webSocketURL, share.id, { role: "edit" });
    await late.synced;
    late.text.insert(0, "late;");
    await sleep(300);
    expect(owner.text.toString()).toBe("owner;");

    await harness.stores.shares.update(share.id, { locked: false });
    await harness.publishPerm(share.id, { version: ++version, kind: "lock" });
    await waitFor(() => member.stateless.length === 2, "unlock notice");
    expect(member.stateless[1]).toEqual({ type: "locked", locked: false, readOnly: false });
  });

  it("applies kick and delete whatever their version, and ignores only a stale role", async () => {
    const {
      share,
      clients: [member, kicked, other],
    } = await room(["edit", "edit", "edit"]);
    if (!member || !kicked || !other) throw new Error("clients missing");
    await harness.publishPerm(share.id, {
      version: 50,
      kind: "role",
      clientId: member.clientId,
      role: "view",
    });
    await waitFor(() => member.stateless.length === 1, "current role");
    // An older role message for the same client would undo the newer one.
    await harness.publishPerm(share.id, {
      version: 49,
      kind: "role",
      clientId: member.clientId,
      role: "edit",
    });
    // The API's counter restarts with Valkey and is not published in order: lower versions of
    // other kinds still apply.
    await harness.publishPerm(share.id, { version: 1, kind: "kick", clientId: kicked.clientId });
    await waitFor(() => kicked.closes.includes("kicked"), "kick with a lower version");
    expect(member.stateless).toEqual([{ type: "role", role: "view", readOnly: true }]);

    await harness.stores.shares.delete(share.id);
    await harness.publishPerm(share.id, { version: 0, kind: "delete" });
    await waitFor(() => other.closes.includes("deleted"), "delete with a lower version");
  });

  it("closes everyone and drops the doc when the share is deleted", async () => {
    const {
      share,
      clients: [owner, member],
    } = await room(["owner", "edit"]);
    if (!owner || !member) throw new Error("clients missing");
    owner.text.insert(0, "before delete");
    await waitFor(
      async () => (await storedText(harness.stores, share.id)) === "before delete",
      "flushed",
    );
    await harness.stores.shares.delete(share.id);
    await harness.publishPerm(share.id, { version: ++version, kind: "delete" });
    await waitFor(
      () => owner.closes.includes("deleted") && member.closes.includes("deleted"),
      "delete closes",
    );
    await waitFor(() => !server.collab.docs.has(share.id), "doc dropped");
    expect(await harness.redis.exists(`doclock:${share.id}`)).toBe(0);
    // Nothing is compacted for a deleted share; the sweeper removes the leftover log.
    expect(await harness.stores.snapshots.latest(share.id, "compact")).toBeNull();
  });
});
