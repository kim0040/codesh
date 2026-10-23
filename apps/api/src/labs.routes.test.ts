import { channels } from "@codesh/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readContent } from "./docs.js";
import {
  type Client,
  createHarness,
  createShare,
  eventually,
  type Harness,
  integration,
  storedDoc,
} from "./testing/harness.js";

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

interface LabView {
  id: string;
  title: string;
  joinCode: string;
  templateShareId: string | null;
  locked: boolean;
  role: "teacher" | "student";
  students: { clientId: string; name: string; shareId: string; joinedAt: string }[];
  expiresAt: string;
}

describe.skipIf(!integration)("labs", () => {
  let forced: string[] = [];
  let h: Harness;
  let base: string;
  let net: ReturnType<Harness["network"]>;
  const streams: { close(): void }[] = [];
  beforeAll(async () => {
    h = await createHarness({
      randomCode: () => forced.shift() ?? String(100_000 + Math.floor(Math.random() * 900_000)),
    });
    base = await h.listen();
  });
  beforeEach(() => {
    net = h.network();
  });
  afterAll(async () => {
    for (const stream of streams) stream.close();
    await h.close();
  });

  const createLab = async (teacher: Client, body: Record<string, unknown> = {}) => {
    const response = await teacher.post("/api/labs", body);
    expect(response.statusCode).toBe(200);
    return response.json<{ id: string; code: string; url: string }>();
  };
  const join = (student: Client, labId: string, name = "Student") =>
    student.post(`/api/labs/${labId}/join`, { name });
  const templateOf = (teacher: Client) =>
    createShare(teacher, {
      title: "Exercise 1",
      language: "python",
      files: [
        { path: "main.py", content: "# TODO: sort the list\n" },
        { path: "data.txt", content: "3 1 2\n" },
      ],
    });

  describe("POST /api/labs and GET /api/labs/:id", () => {
    it("creates a lab with a code of its own namespace and the creator as teacher", async () => {
      const teacher = net.client();
      const teacherId = await teacher.clientId();
      const { id, code, url } = await createLab(teacher, { title: "Algorithms" });
      expect(id).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(code).toMatch(/^[1-9][0-9]{5}$/);
      expect(url).toBe(`/lab/${id}`);
      expect(await h.valkey.get(`labcode:${code}`)).toBe(id);
      expect(await h.valkey.get(`code:${code}`)).toBeNull();
      expect(await h.valkey.ttl(`labcode:${code}`)).toBeGreaterThan(0);
      expect(await h.valkey.zscore("labs:index", id)).not.toBeNull();
      expect(await h.stores.labs.get(id)).toMatchObject({
        title: "Algorithms",
        ownerId: teacherId,
        joinCode: code,
        templateShareId: null,
        locked: false,
        students: [],
      });
    });

    it("resolves the lab code through /api/codes and never hands a code to both a lab and a share", async () => {
      const teacher = net.client();
      forced = ["313131", "313131", "323232"];
      const lab = await createLab(teacher);
      expect(lab.code).toBe("313131");
      const share = await createShare(teacher);
      expect(share.code).toBe("323232");
      expect((await net.client().get("/api/codes/313131")).json()).toEqual({ labId: lab.id });
      expect((await net.client().get("/api/codes/323232")).json()).toEqual({ id: share.id });
    });

    it("accepts a template the teacher owns and refuses others", async () => {
      const teacher = net.client();
      const template = await templateOf(teacher);
      const lab = await createLab(teacher, { templateShareId: template.id });
      expect((await teacher.get(`/api/labs/${lab.id}`)).json<LabView>().templateShareId).toBe(
        template.id,
      );

      const foreign = await net.client().post("/api/labs", { templateShareId: template.id });
      expect(foreign.statusCode).toBe(403);
      expect(errorCode(foreign)).toBe("forbidden");
      const missing = await teacher.post("/api/labs", { templateShareId: "Zz9Zz9Zz" });
      expect(missing.statusCode).toBe(404);
    });

    it("shows the teacher the lab and visitors the student view", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher, { title: "L" });
      const teacherView = (await teacher.get(`/api/labs/${lab.id}`)).json<LabView>();
      expect(teacherView).toMatchObject({
        id: lab.id,
        title: "L",
        joinCode: lab.code,
        role: "teacher",
        locked: false,
      });
      expect(new Date(teacherView.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect((await net.client().get(`/api/labs/${lab.id}`)).json<LabView>()).toMatchObject({
        role: "student",
        students: [],
      });
    });

    it("answers 404 for an unknown lab and 410 for an expired one", async () => {
      const teacher = net.client();
      expect((await teacher.get("/api/labs/Zz9Zz9Zz")).statusCode).toBe(404);
      const lab = await createLab(teacher);
      const record = await h.stores.labs.get(lab.id);
      await h.stores.labs.create({
        ...(record as NonNullable<typeof record>),
        id: "Expired1",
        expiresAt: new Date(Date.now() - 1000),
      });
      const expired = await teacher.get("/api/labs/Expired1");
      expect(expired.statusCode).toBe(410);
      expect(errorCode(expired)).toBe("expired");
      expect((await net.client().get(`/api/codes/${lab.code}`)).statusCode).toBe(200);
    });
  });

  describe("POST /api/labs/:id/join", () => {
    it("gives each student their own copy of the template, owned by them", async () => {
      const teacher = net.client();
      const template = await templateOf(teacher);
      const lab = await createLab(teacher, { templateShareId: template.id });
      const student = net.client();
      const studentId = await student.clientId();

      const response = await join(student, lab.id, "Hana");
      expect(response.statusCode).toBe(200);
      const { shareId } = response.json<{ shareId: string }>();
      expect(shareId).not.toBe(template.id);

      const share = await h.stores.shares.get(shareId);
      expect(share).toMatchObject({
        ownerId: studentId,
        labId: lab.id,
        forkOf: template.id,
        locked: false,
        title: "Exercise 1",
        language: "python",
        access: { default: "view", nearby: false },
      });
      const original = readContent(await storedDoc(h.stores, template.id));
      const copy = readContent(await storedDoc(h.stores, shareId));
      expect(copy.files.map((f) => [f.path, f.content])).toEqual(
        original.files.map((f) => [f.path, f.content]),
      );

      expect(await h.valkey.hget(`profile:${studentId}`, "name")).toBe("Hana");
      const record = await h.stores.labs.get(lab.id);
      expect(record?.students).toEqual([
        expect.objectContaining({ clientId: studentId, name: "Hana", shareId }),
      ]);
      expect((await student.get(`/api/shares/${shareId}`)).json<{ role: string }>().role).toBe(
        "owner",
      );
    });

    it("starts from an empty share when the lab has no template yet", async () => {
      const lab = await createLab(net.client(), { title: "Blank lab" });
      const { shareId } = (await join(net.client(), lab.id)).json<{ shareId: string }>();
      const share = await h.stores.shares.get(shareId);
      expect(share).toMatchObject({ title: "Blank lab", labId: lab.id });
      expect(readContent(await storedDoc(h.stores, shareId)).files[0]?.content).toBe("");
    });

    it("is idempotent, even for a double click", async () => {
      const lab = await createLab(net.client());
      const student = net.client();
      await student.clientId(); // one browser, one cookie: both clicks are the same student
      const [a, b] = await Promise.all([join(student, lab.id), join(student, lab.id)]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(b.json<{ shareId: string }>().shareId).toBe(a.json<{ shareId: string }>().shareId);
      const again = await join(student, lab.id);
      expect(again.json<{ shareId: string }>().shareId).toBe(a.json<{ shareId: string }>().shareId);
      expect(await h.stores.shares.listByLab(lab.id)).toHaveLength(1);
      expect((await h.stores.labs.get(lab.id))?.students).toHaveLength(1);
    });

    it("refuses the teacher, bad names, unknown and expired labs", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const self = await join(teacher, lab.id);
      expect(self.statusCode).toBe(403);
      expect(errorCode(self)).toBe("forbidden");
      expect((await net.client().post(`/api/labs/${lab.id}/join`, {})).statusCode).toBe(400);
      expect((await net.client().post(`/api/labs/${lab.id}/join`, { name: " " })).statusCode).toBe(
        400,
      );
      expect((await join(net.client(), "Zz9Zz9Zz")).statusCode).toBe(404);
    });

    it("lets a student see only their own entry while the teacher sees everyone", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const [s1, s2] = [net.client(), net.client()];
      await join(s1, lab.id, "One");
      await join(s2, lab.id, "Two");
      expect(
        (await teacher.get(`/api/labs/${lab.id}`))
          .json<LabView>()
          .students.map((s) => s.name)
          .sort(),
      ).toEqual(["One", "Two"]);
      const view = (await s1.get(`/api/labs/${lab.id}`)).json<LabView>();
      expect(view.role).toBe("student");
      expect(view.students.map((s) => s.name)).toEqual(["One"]);
    });

    it("tells the teacher over SSE when a student joins", async () => {
      const teacher = net.client();
      const events = await teacher.events(base);
      streams.push(events);
      const lab = await createLab(teacher);
      await join(net.client(), lab.id);
      expect(await events.next("lab")).toEqual({ labId: lab.id, kind: "joined" });
    });
  });

  describe("teacher access to student shares", () => {
    it("lets the teacher edit any student share and stops the student from unlocking", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const student = net.client();
      const { shareId } = (await join(student, lab.id)).json<{ shareId: string }>();

      const teacherJoin = await teacher.post(`/api/shares/${shareId}/join`);
      expect(teacherJoin.statusCode).toBe(200);
      expect(teacherJoin.json<{ role: string }>().role).toBe("edit");

      await teacher.patch(`/api/labs/${lab.id}`, { locked: true });
      expect(
        (await teacher.post(`/api/shares/${shareId}/join`)).json<{ role: string }>().role,
      ).toBe("edit");
      expect(
        (await student.post(`/api/shares/${shareId}/join`)).json<{ role: string }>().role,
      ).toBe("view");

      const unlock = await student.patch(`/api/shares/${shareId}`, { locked: false });
      expect(unlock.statusCode).toBe(403);
      expect(errorCode(unlock)).toBe("forbidden");
      expect((await h.stores.shares.get(shareId))?.locked).toBe(true);

      await teacher.patch(`/api/labs/${lab.id}`, { locked: false });
      expect(
        (await student.post(`/api/shares/${shareId}/join`)).json<{ role: string }>().role,
      ).toBe("owner");
    });
  });

  describe("PATCH /api/labs/:id", () => {
    it("locks and unlocks every student share, tells collab and the students", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const [s1, s2] = [net.client(), net.client()];
      const shares = [
        (await join(s1, lab.id)).json<{ shareId: string }>().shareId,
        (await join(s2, lab.id)).json<{ shareId: string }>().shareId,
      ];
      const perms = await Promise.all(shares.map((id) => h.subscribe(channels.perm(id))));
      const s1Events = await s1.events(base);
      streams.push(s1Events);

      const locked = await teacher.patch(`/api/labs/${lab.id}`, { locked: true });
      expect(locked.statusCode).toBe(200);
      expect(locked.json<LabView>().locked).toBe(true);
      for (const id of shares) expect((await h.stores.shares.get(id))?.locked).toBe(true);
      for (const perm of perms)
        expect(await eventually(() => perm.messages[0])).toMatchObject({ kind: "lock" });
      expect(await s1Events.next("lab")).toEqual({ labId: lab.id, kind: "locked" });

      // Students who join later start locked.
      const late = (await join(net.client(), lab.id)).json<{ shareId: string }>().shareId;
      expect((await h.stores.shares.get(late))?.locked).toBe(true);

      const unlocked = await teacher.patch(`/api/labs/${lab.id}`, { locked: false });
      expect(unlocked.json<LabView>().locked).toBe(false);
      for (const id of [...shares, late])
        expect((await h.stores.shares.get(id))?.locked).toBe(false);
      expect(await s1Events.next("lab", (d) => d.kind === "unlocked")).toEqual({
        labId: lab.id,
        kind: "unlocked",
      });
      for (const perm of perms) perm.stop();
    });

    it("sets and clears the template, for the teacher only", async () => {
      const teacher = net.client();
      const template = await templateOf(teacher);
      const lab = await createLab(teacher);
      const set = await teacher.patch(`/api/labs/${lab.id}`, { templateShareId: template.id });
      expect(set.json<LabView>().templateShareId).toBe(template.id);
      expect((await h.stores.labs.get(lab.id))?.templateShareId).toBe(template.id);
      const cleared = await teacher.patch(`/api/labs/${lab.id}`, { templateShareId: null });
      expect(cleared.json<LabView>().templateShareId).toBeNull();

      const student = net.client();
      const denied = await student.patch(`/api/labs/${lab.id}`, { locked: true });
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe("forbidden");
      const foreign = await student.patch(`/api/labs/${lab.id}`, { templateShareId: template.id });
      expect(foreign.statusCode).toBe(403);
      expect(
        (await teacher.patch(`/api/labs/${lab.id}`, { templateShareId: "Zz9Zz9Zz" })).statusCode,
      ).toBe(404);
      expect((await teacher.patch("/api/labs/Zz9Zz9Zz", { locked: true })).statusCode).toBe(404);
    });
  });

  describe("POST /api/labs/:id/distribute", () => {
    it("gives every student a fresh copy of the template and tells them", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const [s1, s2] = [net.client(), net.client()];
      const before1 = (await join(s1, lab.id, "One")).json<{ shareId: string }>().shareId;
      const before2 = (await join(s2, lab.id, "Two")).json<{ shareId: string }>().shareId;
      const events = await s2.events(base);
      streams.push(events);

      const template = await templateOf(teacher);
      await teacher.patch(`/api/labs/${lab.id}`, { templateShareId: template.id });
      const response = await teacher.post(`/api/labs/${lab.id}/distribute`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ count: 2 });

      const students = (await h.stores.labs.get(lab.id))?.students ?? [];
      expect(students.map((s) => s.name).sort()).toEqual(["One", "Two"]);
      const original = readContent(await storedDoc(h.stores, template.id));
      for (const student of students) {
        expect([before1, before2]).not.toContain(student.shareId);
        const share = await h.stores.shares.get(student.shareId);
        expect(share).toMatchObject({
          ownerId: student.clientId,
          labId: lab.id,
          forkOf: template.id,
        });
        const copy = readContent(await storedDoc(h.stores, student.shareId));
        expect(copy.files.map((f) => [f.path, f.content])).toEqual(
          original.files.map((f) => [f.path, f.content]),
        );
      }
      expect(await events.next("lab")).toEqual({ labId: lab.id, kind: "distributed" });
      const view = (await s1.get(`/api/labs/${lab.id}`)).json<LabView>();
      expect(view.students[0]?.shareId).toBe(students.find((s) => s.name === "One")?.shareId);
    });

    it("needs a template, a teacher, and handles a lab without students", async () => {
      const teacher = net.client();
      const lab = await createLab(teacher);
      const noTemplate = await teacher.post(`/api/labs/${lab.id}/distribute`);
      expect(noTemplate.statusCode).toBe(400);
      expect(errorCode(noTemplate)).toBe("validation");

      const template = await templateOf(teacher);
      await teacher.patch(`/api/labs/${lab.id}`, { templateShareId: template.id });
      expect((await teacher.post(`/api/labs/${lab.id}/distribute`)).json()).toEqual({ count: 0 });
      const denied = await net.client().post(`/api/labs/${lab.id}/distribute`);
      expect(denied.statusCode).toBe(403);
      expect((await teacher.post("/api/labs/Zz9Zz9Zz/distribute")).statusCode).toBe(404);
    });
  });
});
