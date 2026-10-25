import { COLLAB_DENY_REASONS, generateClientId, PERMISSION_APPLY_MS } from "@gachipad/shared";
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
const notices = (client: Client) =>
  client.stateless.filter((message) =>
    ["role", "locked"].includes((message as { type: string }).type),
  );

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

  it("L4: rejects a forged comment author before it reaches another participant", async () => {
    const {
      share,
      clients: [editor, watcher],
    } = await room(["edit", "view"]);
    if (!editor || !watcher) throw new Error("clients missing");
    editor.doc.getArray("comments").push([
      {
        id: "forged",
        fileId: "main",
        anchor: {},
        head: {},
        author: { clientId: generateClientId(), name: "Teacher", color: "#336699" },
        body: "forged attribution",
        createdAt: Date.now(),
        resolved: false,
      },
    ]);
    await waitFor(() => editor.closes.includes("reauth"), "forged author refused");
    expect(watcher.doc.getArray("comments").toJSON()).toEqual([]);
    expect(server.collab.docs.get(share.id)?.document.getArray("comments").toJSON()).toEqual([]);
    expect(
      watcher.received.some((bytes) =>
        new TextDecoder().decode(bytes).includes("forged attribution"),
      ),
    ).toBe(false);
  });

  it("L4: accepts a comment from its verified author and refuses replacement under another author", async () => {
    const {
      share,
      clients: [author, editor],
    } = await room(["edit", "edit"]);
    if (!author || !editor) throw new Error("clients missing");
    const comment = {
      id: "owned-comment",
      fileId: "main",
      anchor: {},
      head: {},
      author: { clientId: author.clientId, name: "Tester", color: "#336699" },
      body: "original",
      createdAt: Date.now(),
      resolved: false,
    };
    author.doc.getArray("comments").push([comment]);
    await waitFor(() => editor.doc.getArray("comments").length === 1, "verified comment received");
    editor.doc.transact(() => {
      editor.doc.getArray("comments").delete(0);
      editor.doc.getArray("comments").push([{ ...comment, body: "impersonated replacement" }]);
    });
    await waitFor(() => editor.closes.includes("reauth"), "replacement refused");
    expect(server.collab.docs.get(share.id)?.document.getArray("comments").toJSON()).toEqual([
      comment,
    ]);
  });

  it("L4: accepts the localized guest name and resolving another author's comment", async () => {
    const {
      share,
      clients: [owner, guest],
    } = await room(["owner", "edit"]);
    if (!owner || !guest) throw new Error("clients missing");
    // The web client shows unnamed guests as "손님 1234"; the token carries "Guest-abcd".
    const comment = {
      id: "guest-comment",
      fileId: "main",
      anchor: {},
      head: {},
      author: { clientId: guest.clientId, name: "손님 1234", color: "#336699" },
      body: "question",
      createdAt: Date.now(),
      resolved: false,
    };
    guest.doc.getArray("comments").push([comment]);
    await waitFor(() => owner.doc.getArray("comments").length === 1, "guest comment received");
    owner.doc.transact(() => {
      owner.doc.getArray("comments").delete(0);
      owner.doc.getArray("comments").push([{ ...comment, resolved: true }]);
    });
    await waitFor(
      () =>
        (guest.doc.getArray("comments").get(0) as { resolved?: boolean } | undefined)?.resolved ===
        true,
      "resolve received",
    );
    expect(guest.closes).toEqual([]);
    expect(owner.closes).toEqual([]);
    expect(server.collab.docs.get(share.id)?.document.getArray("comments").toJSON()).toEqual([
      { ...comment, resolved: true },
    ]);
  });

  it("restricts comment deletion to the author or share owner", async () => {
    const {
      clients: [owner, author, other],
    } = await room(["owner", "edit", "edit"]);
    if (!owner || !author || !other) throw new Error("clients missing");
    const comment = {
      id: "deletion-owned",
      fileId: "main",
      anchor: {},
      head: {},
      author: { clientId: author.clientId, name: "Author", color: "#336699" },
      body: "current comment",
      createdAt: Date.now(),
      resolved: false,
    };
    author.doc.getArray("comments").push([comment]);
    await waitFor(() => other.doc.getArray("comments").length === 1, "comment synced");
    other.doc.getArray("comments").delete(0);
    await waitFor(() => other.closes.includes("reauth"), "foreign deletion refused");
    expect(owner.doc.getArray("comments").toJSON()).toEqual([comment]);
    owner.doc.getArray("comments").delete(0);
    await waitFor(() => author.doc.getArray("comments").length === 0, "owner deletion allowed");
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
    const ms = await elapsedUntil(() => notices(member).length > 0, "role notice");
    expect(ms).toBeLessThan(PERMISSION_APPLY_MS);
    expect(notices(member)).toEqual([{ type: "role", role: "view", readOnly: true }]);
    member.text.insert(0, "blocked;");
    await sleep(300);
    expect(owner.text.toString()).toBe("base;");
    expect(notices(other)).toEqual([]);

    // Down and up again; a client that did not type meanwhile edits normally afterwards.
    await role(other.clientId, "view");
    await waitFor(() => notices(other).length === 1, "other demoted");
    await role(other.clientId, "edit");
    await waitFor(() => notices(other).length === 2, "other promoted");
    expect(notices(other)[1]).toEqual({ type: "role", role: "edit", readOnly: false });
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
    await waitFor(() => notices(member).length > 0 && notices(owner).length > 0, "lock notices");
    expect(notices(member)).toEqual([{ type: "locked", locked: true, readOnly: true }]);
    expect(notices(owner)).toEqual([{ type: "locked", locked: true, readOnly: false }]);

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
    await waitFor(() => notices(member).length === 2, "unlock notice");
    expect(notices(member)[1]).toEqual({ type: "locked", locked: false, readOnly: false });
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
    await waitFor(() => notices(member).length === 1, "current role");
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
    expect(notices(member)).toEqual([{ type: "role", role: "view", readOnly: true }]);

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
