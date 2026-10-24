import { expect, it } from "vitest";
import { presenceFrame } from "./presence-frame.js";

it("serializes a shared presence frame while omitting first, middle, last and absent recipients", () => {
  const users = ["가", "나", "다"].map((name, i) => ({
    clientId: String(i),
    name,
    color: "#336699",
    room: null,
  }));
  const frame = presenceFrame(users);
  expect(presenceFrame(users)).toBe(frame);
  for (const id of ["0", "1", "2", "absent"]) {
    const data = Buffer.concat(frame.chunks(id)).toString().split("data: ")[1]?.trim();
    expect(JSON.parse(data ?? "")).toEqual(users.filter((user) => user.clientId !== id));
  }
  const renamed = users.map((user) =>
    user.clientId === "1" ? { ...user, name: "changed" } : user,
  );
  expect(frame.fingerprint("1")).toBe(presenceFrame(renamed).fingerprint("1"));
  expect(frame.fingerprint("0")).not.toBe(presenceFrame(renamed).fingerprint("0"));
  expect(Buffer.concat(presenceFrame([]).chunks("absent")).toString()).toBe(
    "event: presence\ndata: []\n\n",
  );
});
