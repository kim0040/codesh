import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, integration } from "../../../apps/api/src/testing/harness.js";
import { CliError, configPath, readConfig, resolveUrl } from "./config.js";
import { browserCommand, PACKAGE_NAME, qrOutputType, safeJoin, sharePath } from "./index.js";
import { type Io, run } from "./run.js";

it("exports the package name", () => {
  expect(PACKAGE_NAME).toBe("@gachipad/cli");
});

it("names gachipad in CLI help and keeps the executable name", async () => {
  const stdout: string[] = [];
  const code = await run(["--help"], {
    stdout: (text) => stdout.push(text),
    stderr: () => {},
    env: {},
    cwd: "/",
    readStdin: async () => Buffer.alloc(0),
    stdinIsTTY: true,
    openBrowser: async () => {},
  });
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("gachipad CLI (command: gachipad)");
  expect(stdout.join("")).toContain("gachipad push");
});

describe("server url", () => {
  it("prefers the flag, then GACHIPAD_URL, then the config file", () => {
    expect(resolveUrl("http://a/", { GACHIPAD_URL: "http://b" }, { url: "http://c" })).toBe(
      "http://a",
    );
    expect(resolveUrl(undefined, { GACHIPAD_URL: "http://b" }, { url: "http://c" })).toBe(
      "http://b",
    );
    expect(resolveUrl(undefined, {}, { url: "http://c/" })).toBe("http://c");
    expect(() => resolveUrl(undefined, {}, {})).toThrow(CliError);
    expect(() => resolveUrl("gachipad.corp", {}, {})).toThrow(CliError);
  });

  // legacy codesh name (1.0.x); remove in 2.0
  it("keeps legacy env values and saved config sessions reachable, preferring new values", async () => {
    expect(resolveUrl(undefined, { CODESH_URL: "http://old" }, {})).toBe("http://old");
    expect(
      resolveUrl(undefined, { CODESH_URL: "http://old", GACHIPAD_URL: "http://new" }, {}),
    ).toBe("http://new");
    expect(configPath({ CODESH_CONFIG: "/tmp/old.json" })).toBe("/tmp/old.json");
    const dir = await mkdtemp(join(tmpdir(), "rename-cli-"));
    try {
      const value = { url: "http://old", sessions: { "http://old": "codesh_sid=signed-session" } };
      await writeFile(join(dir, "codesh.json"), JSON.stringify(value));
      expect(await readConfig(join(dir, "gachipad.json"))).toEqual(value);
      await writeFile(join(dir, "gachipad.json"), '{"url":"http://new"}');
      expect(await readConfig(join(dir, "gachipad.json"))).toEqual({ url: "http://new" });
    } finally {
      await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
    }
  });
});

describe("platform-specific paths and terminal integration", () => {
  it("uses APPDATA on Windows and XDG on other platforms", () => {
    expect(
      configPath(
        { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming", XDG_CONFIG_HOME: "/tmp/xdg" },
        "win32",
      ),
    ).toBe("C:\\Users\\Ada\\AppData\\Roaming\\gachipad\\gachipad.json");
    expect(configPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "linux")).toBe("/tmp/xdg/gachipad.json");
    expect(configPath({ GACHIPAD_CONFIG: "C:\\custom\\gachipad.json" }, "win32")).toBe(
      "C:\\custom\\gachipad.json",
    );
  });

  it("normalizes Windows share paths and protects Windows pull paths", () => {
    expect(sharePath("src\\nested\\main.ts", "win32")).toBe("src/nested/main.ts");
    expect(safeJoin("C:\\out", "src\\nested\\main.ts", "win32")).toBe(
      "C:\\out\\src\\nested\\main.ts",
    );
    expect(safeJoin("C:\\out", "..\\outside.txt", "win32")).toBeNull();
    expect(safeJoin("C:\\out", "C:\\outside.txt", "win32")).toBeNull();
    expect(safeJoin("C:\\out", "file:stream.txt", "win32")).toBeNull();
    expect(safeJoin("C:\\out", "NUL.txt", "win32")).toBeNull();
  });

  it("uses a plain QR renderer and the URL handler on Windows", () => {
    expect(qrOutputType("win32")).toBe("utf8");
    expect(qrOutputType("linux")).toBe("terminal");
    expect(browserCommand("win32", "http://gachipad.local/abc12345")).toEqual([
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", "http://gachipad.local/abc12345"],
    ]);
    expect(browserCommand("darwin", "http://gachipad.local/abc12345")[0]).toBe("open");
  });
});

describe("safeJoin", () => {
  it("keeps entries inside the output directory", () => {
    expect(safeJoin("/out", "a/b.py")).toBe("/out/a/b.py");
    expect(safeJoin("/out", "../evil")).toBeNull();
    expect(safeJoin("/out", "a/../../evil")).toBeNull();
    expect(safeJoin("/out", "/etc/passwd")).toBeNull();
  });
});

describe.skipIf(!integration)("against an in-process API", () => {
  let h: Harness;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    h = await createHarness();
    base = await h.listen();
    dir = await mkdtemp(join(tmpdir(), "gachipad-cli-"));
  });
  afterAll(() => h.close());

  /** Runs the CLI with its own home (`GACHIPAD_CONFIG`), so each name is one terminal user. */
  async function runCli(args: string[], user = "default", stdin = "") {
    const out: string[] = [];
    const err: string[] = [];
    const opened: string[] = [];
    const io: Io = {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: { GACHIPAD_CONFIG: join(dir, `${user}.json`), GACHIPAD_URL: base },
      cwd: dir,
      readStdin: async () => Buffer.from(stdin),
      stdinIsTTY: stdin === "",
      openBrowser: async (url) => {
        opened.push(url);
      },
    };
    const code = await run(args, io);
    return { code, out: out.join(""), err: err.join(""), opened };
  }

  it("pushes files, prints the url and the code, and the share can be pulled by code", async () => {
    await writeFile(join(dir, "hello.py"), "print('hi')\n");
    await writeFile(join(dir, "util.py"), "x = 1\n");
    const pushed = await runCli(["push", "hello.py", "util.py", "--title", "My demo", "--no-qr"]);
    expect(pushed.code, pushed.err).toBe(0);
    const code = /code (\d{6})/.exec(pushed.out)?.[1];
    expect(code).toBeDefined();
    expect(pushed.out).toMatch(new RegExp(`${base}/[0-9A-Za-z]{8}\\n`));

    const target = join(dir, "pulled");
    const pulled = await runCli(["pull", code as string, "-o", target], "reader");
    expect(pulled.code, pulled.err).toBe(0);
    expect(await readFile(join(target, "hello.py"), "utf8")).toBe("print('hi')\n");
    expect(await readFile(join(target, "util.py"), "utf8")).toBe("x = 1\n");

    const zipped = await runCli(
      ["pull", code as string, "--zip", "-o", join(dir, "demo.zip")],
      "reader",
    );
    expect(zipped.code, zipped.err).toBe(0);
    expect((await readFile(join(dir, "demo.zip"))).subarray(0, 2).toString()).toBe("PK");
  });

  it("pushes folders with forward-slash paths and preserves CRLF bytes on pull", async () => {
    const source = join(dir, "folder-share");
    await mkdir(join(source, "src", "nested"), { recursive: true });
    const contents = Buffer.from("first\r\nsecond\r\n", "utf8");
    await writeFile(join(source, "src", "nested", "main.ts"), contents);
    const pushed = await runCli(["push", "folder-share", "--no-qr"]);
    expect(pushed.code, pushed.err).toBe(0);
    const code = /code (\d{6})/.exec(pushed.out)?.[1] as string;
    const output = join(dir, "folder-pulled");
    const pulled = await runCli(["pull", code, "-o", output], "folder-reader");
    expect(pulled.code, pulled.err).toBe(0);
    expect(await readFile(join(output, "folder-share", "src", "nested", "main.ts"))).toEqual(
      contents,
    );
  });

  it("prints a QR code unless --no-qr", async () => {
    await writeFile(join(dir, "q.txt"), "q");
    const withQr = await runCli(["push", "q.txt"]);
    expect(withQr.code).toBe(0);
    expect(withQr.out.split("\n").length).toBeGreaterThan(8);
  });

  it("--view-only makes other people viewers", async () => {
    await writeFile(join(dir, "ro.txt"), "read me");
    const pushed = await runCli(["push", "ro.txt", "--view-only", "--no-qr"]);
    expect(pushed.out).toContain("(view only)");
    const id = /\/([0-9A-Za-z]{8})\n/.exec(pushed.out)?.[1] as string;
    const stranger = h.client();
    const joined = await stranger.post(`/api/shares/${id}/join`, {});
    expect(joined.json<{ role: string }>().role).toBe("view");
  });

  it("reads stdin and keeps the owner session between pushes", async () => {
    const first = await runCli(
      ["push", "-", "--name", "pipe.js", "--no-qr"],
      "owner",
      "let a = 1;\n",
    );
    expect(first.code, first.err).toBe(0);
    const second = await runCli(
      ["push", "-", "--name", "pipe2.js", "--no-qr"],
      "owner",
      "let b = 2;\n",
    );
    const idOf = (text: string) => /\/([0-9A-Za-z]{8})\n/.exec(text)?.[1] as string;
    const config = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as {
      sessions: Record<string, string>;
    };
    expect(Object.keys(config.sessions)).toEqual([base]);
    // Both shares belong to the same client: the list shows both as owned.
    const cookie = config.sessions[base] as string;
    const list = await fetch(`${base}/api/shares`, { headers: { cookie } });
    const ids = ((await list.json()) as { id: string; role: string }[]).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([idOf(first.out), idOf(second.out)]));
  });

  it("open prints the url of a code, and opens the browser unless --print", async () => {
    await writeFile(join(dir, "o.txt"), "o");
    const pushed = await runCli(["push", "o.txt", "--no-qr"]);
    const code = /code (\d{6})/.exec(pushed.out)?.[1] as string;
    const id = /\/([0-9A-Za-z]{8})\n/.exec(pushed.out)?.[1] as string;
    const printed = await runCli(["open", code, "--print"], "other");
    expect(printed.out).toBe(`${base}/${id}\n`);
    expect(printed.opened).toEqual([]);
    const opened = await runCli(["open", id], "other");
    expect(opened.opened).toEqual([`${base}/${id}`]);
  });

  it("explains errors instead of crashing", async () => {
    const missing = await runCli(["push", "nope.txt"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Cannot read nope.txt");
    const unknown = await runCli(["open", "999999"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("not_found");
    const bad = await runCli(["pull", "abc"]);
    expect(bad.code).toBe(1);
    await writeFile(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    const binary = await runCli(["push", "bin.dat"]);
    expect(binary.err).toContain("binary");
  });
});
