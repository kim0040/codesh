import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

/** Platform config file: `%APPDATA%/gachipad/gachipad.json` on Windows, otherwise XDG config. */
export interface ConfigFile {
  url?: string;
  /** Session cookie per server origin, so repeated pushes belong to one owner. */
  sessions?: Record<string, string>;
}

export function configPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = cliEnv(env, "GACHIPAD_CONFIG");
  if (override) return override;
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(homedir(), "AppData", "Roaming");
    return win32.join(appData, "gachipad", "gachipad.json");
  }
  return posix.join(env.XDG_CONFIG_HOME || posix.join(homedir(), ".config"), "gachipad.json");
}

export async function readConfig(path: string): Promise<ConfigFile> {
  try {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // legacy codesh name (1.0.x); remove in 2.0
      const legacy = path
        .replace(/gachipad([/\\])gachipad\.json$/, "codesh$1codesh.json")
        .replace(/gachipad\.json$/, "codesh.json");
      if (legacy === path) throw error;
      text = await readFile(legacy, "utf8");
    }
    const parsed: unknown = JSON.parse(text);
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

/** Server URL: `--url`, then `GACHIPAD_URL`, then the config file. No trailing slash. */
export function resolveUrl(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  config: ConfigFile,
): string {
  const url = flag || cliEnv(env, "GACHIPAD_URL") || config.url;
  if (!url) {
    throw new CliError(
      'No server URL. Pass --url, set GACHIPAD_URL or put {"url": "http://..."} in the gachipad CLI config file (%APPDATA%\\gachipad\\gachipad.json on Windows, ~/.config/gachipad.json elsewhere)',
    );
  }
  if (!/^https?:\/\//.test(url)) throw new CliError(`Invalid server URL: ${url}`);
  return url.replace(/\/+$/, "");
}

export class CliError extends Error {}

let warned = false;
function cliEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // legacy codesh name (1.0.x); remove in 2.0
  const legacy = name.replace(/^GACHIPAD_/, "CODESH_");
  if (env[name] !== undefined) return env[name];
  if (env[legacy] !== undefined && !warned) {
    warned = true;
    console.warn("Legacy product environment settings are deprecated; use GACHIPAD_ names");
  }
  return env[legacy];
}
