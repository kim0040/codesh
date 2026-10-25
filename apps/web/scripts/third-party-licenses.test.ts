import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectClosure, renderLicenses } from "./third-party-licenses";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gachipad-licenses-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A package in a pnpm-style store: node_modules/.pnpm/<name>@<version>/node_modules/<name>. */
function store(
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
  files: Record<string, string> = { LICENSE: `${name} licence\r\n` },
) {
  const dir = `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;
  write(`${dir}/package.json`, JSON.stringify({ name, version, license: "MIT", ...extra }));
  for (const [file, text] of Object.entries(files)) write(`${dir}/${file}`, text);
  return join(root, dir);
}

function link(from: string, name: string, target: string) {
  mkdirSync(dirname(join(from, "node_modules", name)), { recursive: true });
  symlinkSync(target, join(from, "node_modules", name));
}

describe("collectClosure", () => {
  it("follows dependencies through workspace packages and skips devDependencies", () => {
    write(
      "apps/web/package.json",
      '{"name":"web","dependencies":{"@w/lib":"workspace:*"},"devDependencies":{"dev-only":"1"}}',
    );
    write("packages/lib/package.json", '{"name":"@w/lib","dependencies":{"a":"1"}}');
    link(join(root, "apps/web"), "@w/lib", join(root, "packages/lib"));
    const a = store("a", "1.0.0", { dependencies: { b: "1" } });
    const b = store("b", "2.0.0");
    store("dev-only", "1.0.0");
    link(join(root, "packages/lib"), "a", a);
    symlinkSync(b, join(dirname(a), "b"));

    const names = collectClosure(join(root, "apps/web")).map((p) => `${p.name}@${p.version}`);
    expect(names).toEqual(["a@1.0.0", "b@2.0.0"]);
  });

  it("skips optional dependencies that are not installed and fails on missing required ones", () => {
    write("app/package.json", '{"name":"app","optionalDependencies":{"gone":"1"}}');
    expect(collectClosure(join(root, "app"))).toEqual([]);
    write("app/package.json", '{"name":"app","dependencies":{"gone":"1"}}');
    expect(() => collectClosure(join(root, "app"))).toThrow(/gone .* is not installed/);
  });

  it("includes peer dependencies that are installed", () => {
    write("app/package.json", '{"name":"app","dependencies":{"p":"1"}}');
    const p = store("p", "1.0.0", { peerDependencies: { q: "1", absent: "1" } });
    symlinkSync(store("q", "1.0.0"), join(dirname(p), "q"));
    link(join(root, "app"), "p", p);
    expect(collectClosure(join(root, "app")).map((x) => x.name)).toEqual(["p", "q"]);
  });

  it("reads licence and notice files, normalised", () => {
    write("app/package.json", '{"name":"app","dependencies":{"c":"1"}}');
    link(
      join(root, "app"),
      "c",
      store(
        "c",
        "1.0.0",
        { license: "Apache-2.0" },
        {
          LICENSE: "Apache text  \r\n",
          NOTICE: "c notice\n",
          "README.md": "not a licence",
        },
      ),
    );
    const [pkg] = collectClosure(join(root, "app"));
    expect(pkg?.files).toEqual([
      { name: "LICENSE", text: "Apache text" },
      { name: "NOTICE", text: "c notice" },
    ]);
  });

  it("fails for a package without licence text unless it is a known exception", () => {
    write(
      "app/package.json",
      '{"name":"app","dependencies":{"d":"1","react-remove-scroll-bar":"1"}}',
    );
    link(join(root, "app"), "d", store("d", "1.0.0", {}, {}));
    link(
      join(root, "app"),
      "react-remove-scroll-bar",
      store("react-remove-scroll-bar", "2.0.0", {}, {}),
    );
    expect(() => collectClosure(join(root, "app"))).toThrow(
      /d@1.0.0 \(MIT\) ships no licence text/,
    );

    write("app/package.json", '{"name":"app","dependencies":{"react-remove-scroll-bar":"1"}}');
    expect(collectClosure(join(root, "app")).map((p) => p.name)).toEqual([
      "react-remove-scroll-bar",
    ]);

    store("react-remove-scroll-bar", "2.0.0", { license: "GPL-3.0" }, {});
    expect(() => collectClosure(join(root, "app"))).toThrow(/ships no licence text/);
  });
});

describe("renderLicenses", () => {
  it("is deterministic and lists every package", () => {
    const packages = [
      {
        name: "a",
        version: "1.0.0",
        license: "MIT",
        repository: "https://x/a",
        author: undefined,
        files: [{ name: "LICENSE", text: "A text" }],
      },
      {
        name: "b",
        version: "1.0.0",
        license: "ISC",
        repository: undefined,
        author: "B",
        files: [],
      },
    ];
    const first = renderLicenses(packages, "Linguist text\r\n");
    expect(renderLicenses(packages, "Linguist text\r\n")).toBe(first);
    expect(first).toContain("  a@1.0.0  MIT\n  b@1.0.0  ISC\n");
    expect(first).toContain("Linguist text");
    expect(first).toContain("A text");
    expect(first).toContain("This package ships no licence file");
    expect(first.endsWith("\n")).toBe(true);
  });
});
