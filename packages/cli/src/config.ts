import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.config/codesh.json`: `{ "url": "http://codesh.corp" }`, plus the sessions the CLI keeps. */
export interface ConfigFile {
  url?: string;
  /** Session cookie per server origin, so repeated pushes belong to one owner. */
  sessions?: Record<string, string>;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return (
    env.CODESH_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "codesh.json")
  );
}

export async function readConfig(path: string): Promise<ConfigFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : {};
  } catch {
    return {};
  }
}

export async function writeConfig(path: string, config: ConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The file holds session cookies: owner only.
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Server URL: `--url`, then `CODESH_URL`, then the config file. No trailing slash. */
export function resolveUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: ConfigFile,
): string {
  const url = flag || env.CODESH_URL || config.url;
  if (!url) {
    throw new CliError(
      'No server URL. Pass --url, set CODESH_URL or put {"url": "http://..."} in ~/.config/codesh.json',
    );
  }
  if (!/^https?:\/\//.test(url)) throw new CliError(`Invalid server URL: ${url}`);
  return url.replace(/\/+$/, "");
}

export class CliError extends Error {}
