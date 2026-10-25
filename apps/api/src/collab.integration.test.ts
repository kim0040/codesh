import { YDOC } from "@codesh/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Harness as CollabHarness,
  servicesAvailable,
  storedText,
  TEST_SECRET,
  waitFor,
} from "../../collab/src/testing/harness.js";
import { createHarness, createShare, type Harness, integration } from "./testing/harness.js";

const available = integration && (await servicesAvailable());

/**
 * The API and a real collab server on one database and one Valkey: content changes go over `cmd:`.
 * Collab answers every `cmd:*` channel (pub/sub ignores Valkey databases), so this file runs on its
 * own, after the route tests, which stand in for collab with `Harness.collab`.
 */
describe.runIf(available)("content changes through a real collab server", () => {
  let collab: CollabHarness;
  let api: Harness;

  beforeAll(async () => {
    collab = await CollabHarness.create();
    api = await createHarness({
      stores: collab.stores,
      collab: "none",
      config: { collabSecret: TEST_SECRET },
    });
  });
  afterAll(async () => {
    await api?.close();
    await collab?.close();
  });

  const joined = async (client: ReturnType<Harness["client"]>, id: string, url: string) => {
    const { token } = (await client.post(`/api/shares/${id}/join`)).json<{ token: string }>();
    return collab.connect(url, id, { token });
  };

  it("H1: a lab lock immediately stops a connected student but lets the teacher edit", async () => {
    const server = await collab.startServer();
    const teacher = api.client();
    const student = api.client();
    const labResponse = await teacher.post("/api/labs", { title: "Security lab" });
    expect(labResponse.statusCode).toBe(200);
    const labId = labResponse.json<{ id: string }>().id;
    const studentResponse = await student.post(`/api/labs/${labId}/join`, { name: "Student" });
    expect(studentResponse.statusCode).toBe(200);
    const id = studentResponse.json<{ shareId: string }>().shareId;
    const studentEditor = await joined(student, id, server.webSocketURL);
    const teacherEditor = await joined(teacher, id, server.webSocketURL);
    await Promise.all([studentEditor.synced, teacherEditor.synced]);
    expect((await teacher.patch(`/api/labs/${labId}`, { locked: true })).statusCode).toBe(200);
    await waitFor(
      () =>
        [studentEditor, teacherEditor].every((client) =>
          client.stateless.some((message) => (message as { type: string }).type === "locked"),
        ),
      "lock delivered",
    );
    expect(
      studentEditor.stateless.findLast(
        (message) => (message as { type: string }).type === "locked",
      ),
    ).toMatchObject({ type: "locked", readOnly: true });
    expect(
      teacherEditor.stateless.findLast(
        (message) => (message as { type: string }).type === "locked",
      ),
    ).toMatchObject({ type: "locked", readOnly: false });
    studentEditor.text.insert(0, "forbidden student text");
    teacherEditor.text.insert(0, "teacher text");
    await waitFor(
      () => server.collab.docs.get(id)?.document.getText("file:main").toString() === "teacher text",
      "teacher edit accepted, student update rejected",
    );
    await waitFor(
      async () => (await storedText(collab.stores, id)) === "teacher text",
      "teacher edit persisted",
    );
  });

  it.each(["kick", "ban", "view", "key", "pin"])(
    "M1: rejects an old collab token after %s through the API",
    async (change) => {
      const server = await collab.startServer();
      const owner = api.client();
      const guest = api.client();
      const { id } = await createShare(owner);
      if (change === "key") await owner.patch(`/api/shares/${id}`, { access: { default: "view" } });
      const share = await api.stores.shares.get(id);
      const token = (
        await guest.post(
          `/api/shares/${id}/join`,
          change === "key" ? { editKey: share?.access.editKey } : {},
        )
      ).json<{ token: string }>().token;
      const connected = await collab.connect(server.webSocketURL, id, { token });
      await connected.synced;
      const response =
        change === "kick" || change === "ban"
          ? await owner.post(`/api/shares/${id}/kick`, {
              clientId: await guest.clientId(),
              ban: change === "ban",
            })
          : await owner.patch(`/api/shares/${id}`, {
              access:
                change === "view"
                  ? { default: "view" }
                  : change === "key"
                    ? { rotateEditKey: true }
                    : { pin: "654321" },
            });
      expect(response.statusCode).toBe(200);
      await waitFor(() => connected.closes.length > 0, "existing connection revoked");
      const replay = await collab.connect(server.webSocketURL, id, { token });
      expect(await Promise.race([replay.denied, replay.synced.then(() => "accepted")])).toBe(
        change === "ban" ? "banned" : "unauthorized",
      );
    },
  );

  it("restore through the API changes the text of a connected client", async () => {
    const server = await collab.startServer();
    const owner = api.client();
    const { id } = await createShare(owner, { files: [{ path: "main.txt", content: "" }] });
    const editor = await joined(owner, id, server.webSocketURL);
    const watcher = await joined(api.client(), id, server.webSocketURL);
    await Promise.all([editor.synced, watcher.synced]);
    editor.text.insert(0, "first version");
    await waitFor(() => watcher.text.toString() === "first version", "watcher sees the text");

    // Collab keeps a history snapshot of edits; the owner reads its seq through the API.
    const state = server.collab.docs.get(id);
    if (!state) throw new Error("share is not loaded");
    await state.core.history(true);
    const [entry] = (await owner.get(`/api/shares/${id}/history`)).json<{ seq: number }[]>();
    expect(entry).toBeDefined();

    editor.text.delete(0, "first".length);
    editor.text.insert(0, "second");
    await waitFor(() => watcher.text.toString() === "second version", "watcher sees the edit");

    const response = await owner.post(`/api/shares/${id}/restore`, {
      seq: (entry as { seq: number }).seq,
    });
    expect(response.statusCode).toBe(200);
    await waitFor(
      () =>
        editor.text.toString() === "first version" && watcher.text.toString() === "first version",
      "both clients restored",
    );
    expect(await storedText(collab.stores, id)).toBe("first version");

    // The API itself never appended to the update log: every entry came from collab.
    expect(await collab.stores.updates.lastSeq(id)).toBeGreaterThan(0);
  });

  it("title and language changes reach the connected clients and the stored share", async () => {
    const server = await collab.startServer();
    const owner = api.client();
    const { id } = await createShare(owner, { title: "Old", language: "python" });
    const viewer = await joined(api.client(), id, server.webSocketURL);
    await viewer.synced;

    const response = await owner.patch(`/api/shares/${id}`, { title: "New", language: "go" });
    expect(response.statusCode).toBe(200);
    const meta = viewer.doc.getMap<string>(YDOC.meta);
    await waitFor(
      () => meta.get("title") === "New" && meta.get("language") === "go",
      "viewer sees the new meta",
    );
    expect(await collab.stores.shares.get(id)).toMatchObject({ title: "New", language: "go" });
  });
});
