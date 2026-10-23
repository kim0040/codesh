import { describe, expect, it } from "vitest";
import { userFilter } from "./real.js";

describe("userFilter", () => {
  it("replaces every placeholder with the escaped name", () => {
    expect(userFilter("(|(uid={{username}})(mail={{username}}@corp))", "alice")).toBe(
      "(|(uid=alice)(mail=alice@corp))",
    );
    expect(userFilter("(uid={{username}})", "a*)(uid=*")).toBe("(uid=a\\2a\\29\\28uid=\\2a)");
  });

  it("does not expand $ patterns of the name into the template", () => {
    for (const name of ["$&", "$`", "$'", "a$&b", "$1"]) {
      const filter = userFilter("(&(objectClass=person)(uid={{username}}))", name);
      expect(filter).toBe(`(&(objectClass=person)(uid=${name}))`);
    }
  });
});
