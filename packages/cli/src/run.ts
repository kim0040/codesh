import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import QRCode from "qrcode";
import { Client } from "./client.js";
import { CliError, configPath, readConfig, resolveUrl } from "./config.js";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Reads all of stdin; only called for `push -` or a pipe without file arguments. */
  readStdin: () => Promise<Buffer>;
  stdinIsTTY: boolean;
  openBrowser: (url: string, platform?: NodeJS.Platform) => Promise<void>;
  /** Optional platform override for deterministic platform-specific tests. */
  platform?: NodeJS.Platform;
}

export const HELP = `gachipad CLI (command: codesh) - share code from the terminal

usage:
  codesh push <file|folder...> [--title <t>] [--language <id>] [--view-only] [--no-qr] [--name <file>] [--url <u>]
  codesh push -  --name snippet.py          read the content from stdin
  codesh open <code|id> [--print] [--url <u>]
  codesh pull <code|id> [-o <dir>] [--zip] [--pin <pin>] [--url <u>]

The server comes from --url, CODESH_URL or the gachipad CLI config file (%APPDATA%\\codesh\\codesh.json on Windows, ~/.config/codesh.json elsewhere).`;

interface CreateResponse {
  id: string;
  code: string;
  url: string;
}
type CodeResponse = { id: string } | { labId: string };
interface ShareView {
  id: string;
  title: string;
  needsPin: boolean;
  requireApproval: boolean;
}

const JOIN_CODE = /^[1-9][0-9]{5}$/;
const SHARE_ID = /^[0-9A-Za-z]{8}$/;

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "push":
        await push(rest, io);
        return 0;
      case "open":
        await open(rest, io);
        return 0;
      case "pull":
        await pull(rest, io);
        return 0;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.stdout(`${HELP}\n`);
        return command === undefined ? 2 : 0;
      default:
        throw new CliError(`Unknown command "${command}". Try: codesh --help`);
    }
  } catch (error) {
    if (
      error instanceof CliError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      io.stderr(`codesh: ${(error as Error).message}\n`);
      return 1;
    }
    throw error;
  }
}

async function connect(flag: string | undefined, io: Io): Promise<Client> {
  const file = configPath(io.env, io.platform);
  const config = await readConfig(file);
  return new Client(resolveUrl(flag, io.env, config), config, file);
}

function absoluteUrl(client: Client, url: string): string {
  return /^https?:\/\//.test(url) ? url : `${client.base}${url.startsWith("/") ? "" : "/"}${url}`;
}

// --- push ------------------------------------------------------------------------------------

async function push(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      language: { type: "string" },
      "view-only": { type: "boolean" },
      "no-qr": { type: "boolean" },
      name: { type: "string" },
      url: { type: "string" },
    },
  });

  const files: { path: string; language?: string; content: string }[] = [];
  const platform = io.platform ?? process.platform;
  const fromStdin =
    positionals.length === 0 || (positionals.length === 1 && positionals[0] === "-");
  if (fromStdin) {
    if (positionals.length === 0 && io.stdinIsTTY) {
      throw new CliError(
        "Nothing to push. Give file names, or pipe text in with: codesh push - --name file.py",
      );
    }
    files.push({
      path: sharePath(values.name ?? "snippet.txt", platform),
      content: decode(await io.readStdin(), "stdin"),
    });
  } else {
    const seen = new Set<string>();
    for (const name of positionals) {
      const path = resolve(io.cwd, name);
      try {
        await readdir(path, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTDIR") {
          throw new CliError(`Cannot read ${name}: ${code ?? error}`);
        }
        await appendFile(path, sharePath(basename(path), platform), name, files, seen);
        continue;
      }
      const rel = relative(io.cwd, path);
      const prefix =
        rel === "."
          ? ""
          : rel === ".." || rel.startsWith(`..${(platform === "win32" ? win32 : posix).sep}`)
            ? sharePath(basename(path), platform)
            : sharePath(rel, platform);
      const countBefore = files.length;
      await appendDirectory(path, prefix, name, files, seen, platform);
      if (files.length === countBefore) throw new CliError(`Cannot share empty directory ${name}`);
    }
  }
  for (const file of files) if (values.language) file.language = values.language;

  const client = await connect(values.url, io);
  const created = await client.json<CreateResponse>("POST", "/api/shares", {
    title: values.title ?? (files.length === 1 ? files[0]?.path : undefined),
    ...(values.language ? { language: values.language } : {}),
    files,
  });
  if (values["view-only"]) {
    await client.json("PATCH", `/api/shares/${created.id}`, { access: { default: "view" } });
  }

  const url = absoluteUrl(client, created.url || `/${created.id}`);
  if (!values["no-qr"])
    io.stdout(`${await QRCode.toString(url, { type: qrOutputType(platform), small: true })}\n`);
  io.stdout(`${url}\n`);
  io.stdout(`code ${created.code}${values["view-only"] ? " (view only)" : ""}\n`);
}

function decode(data: Buffer, label: string): string {
  if (data.includes(0))
    throw new CliError(`${label} looks like a binary file; only text can be shared`);
  return data.toString("utf8");
}

async function appendFile(
  diskPath: string,
  shareName: string,
  label: string,
  files: { path: string; language?: string; content: string }[],
  seen: Set<string>,
): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(diskPath);
  } catch (error) {
    throw new CliError(`Cannot read ${label}: ${(error as NodeJS.ErrnoException).code ?? error}`);
  }
  if (seen.has(shareName)) throw new CliError(`Two files are called ${shareName}`);
  seen.add(shareName);
  files.push({ path: shareName, content: decode(data, label) });
}

async function appendDirectory(
  directory: string,
  prefix: string,
  label: string,
  files: { path: string; language?: string; content: string }[],
  seen: Set<string>,
  platform: NodeJS.Platform,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const diskPath = join(directory, entry.name);
    const shareName = sharePath(prefix ? `${prefix}/${entry.name}` : entry.name, platform);
    if (entry.isDirectory()) {
      await appendDirectory(diskPath, shareName, label, files, seen, platform);
    } else if (entry.isFile()) {
      await appendFile(diskPath, shareName, label, files, seen);
    } else {
      throw new CliError(`Cannot share unsupported path ${diskPath}`);
    }
  }
}

/** Converts a local path into the forward-slash form used in share archives. */
export function sharePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  return value.replaceAll(platform === "win32" ? "\\" : path.sep, "/");
}

/** Windows terminals without ANSI support get the plain UTF-8 QR renderer. */
export function qrOutputType(platform: NodeJS.Platform = process.platform): "terminal" | "utf8" {
  return platform === "win32" ? "utf8" : "terminal";
}

// --- open ------------------------------------------------------------------------------------

async function resolveTarget(
  client: Client,
  target: string,
): Promise<{ path: string; id: string }> {
  if (SHARE_ID.test(target) && /[A-Za-z]/.test(target)) return { path: `/${target}`, id: target };
  if (!JOIN_CODE.test(target)) {
    throw new CliError(`"${target}" is neither a 6-digit code nor an 8-character share id`);
  }
  const found = await client.json<CodeResponse>("GET", `/api/codes/${target}`);
  const id = "labId" in found ? found.labId : found.id;
  if (typeof id !== "string" || !SHARE_ID.test(id) || !/[A-Za-z]/.test(id))
    throw new CliError("The server returned an invalid share id");
  return { path: "labId" in found ? `/lab/${id}` : `/${id}`, id };
}

async function open(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { print: { type: "boolean" }, url: { type: "string" } },
  });
  const [target] = positionals;
  if (!target || positionals.length > 1)
    throw new CliError("usage: codesh open <code|id> [--print]");
  const client = await connect(values.url, io);
  const { path } = await resolveTarget(client, target);
  const url = `${client.base}${path}`;
  io.stdout(`${url}\n`);
  if (!values.print) await io.openBrowser(url, io.platform ?? process.platform);
}

// --- pull ------------------------------------------------------------------------------------

/** A path inside `root` for an archive entry, or null if the entry would escape it. */
export function safeJoin(
  root: string,
  entry: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = platform === "win32" ? win32 : posix;
  const cleaned = path.normalize(entry.replaceAll("\\", "/"));
  if (!cleaned || path.isAbsolute(cleaned)) return null;
  if (
    platform === "win32" &&
    cleaned
      .split(path.sep)
      .some(
        (part) =>
          part.includes(":") ||
          part.endsWith(".") ||
          part.endsWith(" ") ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part),
      )
  ) {
    return null;
  }
  const full = path.join(root, cleaned);
  const relativePath = path.relative(root, full);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return full;
}

async function pull(args: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      zip: { type: "boolean" },
      pin: { type: "string" },
      url: { type: "string" },
    },
  });
  const [target] = positionals;
  if (!target || positionals.length > 1)
    throw new CliError("usage: codesh pull <code|id> [-o dir] [--zip]");
  const client = await connect(values.url, io);
  const { path, id } = await resolveTarget(client, target);
  if (path.startsWith("/lab/"))
    throw new CliError("This code belongs to a lab; open it in the browser");

  const view = await client.json<ShareView>("GET", `/api/shares/${id}`);
  if (view.needsPin || view.requireApproval) {
    if (view.needsPin && values.pin === undefined)
      throw new CliError("This share needs a PIN: pass --pin");
    if (view.requireApproval && !view.needsPin) {
      throw new CliError("The owner has to approve you first; open the share in the browser");
    }
    await client.json("POST", `/api/shares/${id}/join`, { pin: values.pin });
  }

  const archive = new Uint8Array(
    await (await client.request("GET", `/api/shares/${id}/download`)).arrayBuffer(),
  );
  const safeName =
    view.title
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .replace(/^\.+/, "")
      .trim() || id;
  const output = resolve(io.cwd, values.output ?? (values.zip ? "." : safeName));

  if (values.zip) {
    const file = values.output?.endsWith(".zip") ? output : join(output, `${safeName}.zip`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, archive);
    io.stdout(`${file}\n`);
    return;
  }

  const entries = unzipSync(archive);
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  await mkdir(output, { recursive: true });
  for (const name of names) {
    const target = safeJoin(output, name, io.platform ?? process.platform);
    if (!target) throw new CliError(`Refusing to write outside the output directory: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entries[name] as Uint8Array);
    io.stdout(`${target}\n`);
  }
}

// --- browser ---------------------------------------------------------------------------------

export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  return platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
}

export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const [command, args] = browserCommand(platform, url);
  return new Promise((resolveOpen) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, shell: false });
    // No browser (a server over ssh): the URL was printed already.
    child.on("error", () => resolveOpen());
    child.unref();
    resolveOpen();
  });
}
