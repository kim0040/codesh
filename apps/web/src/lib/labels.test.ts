import { describe, expect, it } from "vitest";
import {
  ALL_FOLDERS,
  labelKey,
  listFolders,
  listTags,
  matchesLabels,
  matchesQuery,
  pruneFilters,
  resolveFolderName,
  suggestFolders,
  suggestTags,
} from "./labels";

const share = (folder: string | null, ...tags: string[]) => ({ folder, tags });
const SHARES = [
  share("Week 1", "java", "loops"),
  share("week 1", "Java"),
  share("Week 10", "python"),
  share(null, "loops"),
  share(null),
];

describe("listFolders", () => {
  it("counts per folder ignoring case, sorts naturally and counts the unfiled", () => {
    expect(listFolders(SHARES)).toEqual({
      folders: [
        { key: "week 1", name: "Week 1", count: 2 },
        { key: "week 10", name: "Week 10", count: 1 },
      ],
      unfiled: 2,
    });
  });

  it("is empty without folders", () => {
    expect(listFolders([share(null)])).toEqual({ folders: [], unfiled: 1 });
  });
});

describe("listTags", () => {
  it("merges tags that differ only in case and counts them", () => {
    expect(listTags(SHARES)).toEqual([
      { key: "java", name: "java", count: 2 },
      { key: "loops", name: "loops", count: 2 },
      { key: "python", name: "python", count: 1 },
    ]);
  });
});

describe("matchesLabels", () => {
  const first = SHARES[0] as (typeof SHARES)[number];
  it("matches everything with no filter", () => {
    expect(SHARES.every((s) => matchesLabels(s, ALL_FOLDERS, []))).toBe(true);
  });

  it("filters by folder, case-insensitively, and by 'no folder'", () => {
    const key = labelKey("WEEK 1");
    expect(SHARES.filter((s) => matchesLabels(s, { kind: "folder", key }, []))).toHaveLength(2);
    expect(SHARES.filter((s) => matchesLabels(s, { kind: "none" }, []))).toHaveLength(2);
  });

  it("needs every selected tag", () => {
    expect(matchesLabels(first, ALL_FOLDERS, ["java"])).toBe(true);
    expect(matchesLabels(first, ALL_FOLDERS, ["java", "loops"])).toBe(true);
    expect(matchesLabels(first, ALL_FOLDERS, ["java", "python"])).toBe(false);
  });

  it("combines folder and tags", () => {
    const folder = { kind: "folder", key: "week 1" } as const;
    expect(SHARES.filter((s) => matchesLabels(s, folder, ["loops"]))).toEqual([first]);
  });
});

describe("pruneFilters", () => {
  it("keeps filters that still match something", () => {
    const folder = { kind: "folder", key: "week 1" } as const;
    expect(pruneFilters(folder, ["java"], SHARES)).toEqual({ folder, tags: ["java"] });
  });

  it("drops a folder or tag nothing uses any more", () => {
    expect(pruneFilters({ kind: "folder", key: "gone" }, ["nope", "java"], SHARES)).toEqual({
      folder: ALL_FOLDERS,
      tags: ["java"],
    });
    expect(pruneFilters({ kind: "none" }, [], [share("A")]).folder).toEqual(ALL_FOLDERS);
  });
});

describe("folder input", () => {
  const { folders } = listFolders(SHARES);

  it("suggests folders by prefix first, then by containment", () => {
    expect(suggestFolders(folders, "").map((f) => f.name)).toEqual(["Week 1", "Week 10"]);
    expect(suggestFolders(folders, "10").map((f) => f.name)).toEqual(["Week 10"]);
    expect(suggestFolders(folders, "wee").map((f) => f.name)).toEqual(["Week 1", "Week 10"]);
    expect(suggestFolders(folders, "zzz")).toEqual([]);
  });

  it("reuses the spelling of an existing folder", () => {
    expect(resolveFolderName("  WEEK 1 ", folders)).toBe("Week 1");
    expect(resolveFolderName("New one", folders)).toBe("New one");
  });
});

describe("suggestTags", () => {
  const tags = listTags(SHARES);
  it("leaves out chosen tags, filters by the typed text and puts common tags first", () => {
    expect(suggestTags(tags, ["JAVA"], "").map((t) => t.name)).toEqual(["loops", "python"]);
    expect(suggestTags(tags, [], "py").map((t) => t.name)).toEqual(["python"]);
    expect(suggestTags(tags, [], "").map((t) => t.name)).toEqual(["java", "loops", "python"]);
  });
});

describe("matchesQuery", () => {
  const item = {
    id: "AbCd1234",
    title: "Loops homework",
    folder: "Week 1",
    tags: ["Java", "loops"],
  };
  it("finds a share by title, code, folder or tag, ignoring case", () => {
    for (const query of ["homework", "abcd", "WEEK", "java", "  oop "]) {
      expect(matchesQuery(item, query), query).toBe(true);
    }
  });
  it("matches everything for an empty query and nothing for an unknown word", () => {
    expect(matchesQuery(item, "  ")).toBe(true);
    expect(matchesQuery(item, "python")).toBe(false);
    expect(matchesQuery({ ...item, folder: null, tags: [] }, "week")).toBe(false);
  });
});
