import { CliError, type ConfigFile, writeConfig } from "./config.js";

const SESSION_COOKIE = "codesh_sid";

/** A minimal API client: sends `X-Codesh: 1` on changes (apps/api/README.md) and keeps the session cookie. */
export class Client {
  private cookie: string;

  constructor(
    readonly base: string,
    private readonly config: ConfigFile,
    private readonly configFile: string,
  ) {
    this.cookie = config.sessions?.[base] ?? "";
  }

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(method === "GET" ? {} : { "x-codesh": "1" }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliError(`Cannot reach ${this.base}: ${(error as Error).message}`);
    }
    await this.remember(response);
    if (!response.ok) throw await apiError(response);
    return response;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.request(method, path, body)).json() as Promise<T>;
  }

  private async remember(response: Response): Promise<void> {
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] as string)
      .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie || cookie === this.cookie) return;
    this.cookie = cookie;
    this.config.sessions = { ...this.config.sessions, [this.base]: cookie };
    try {
      await writeConfig(this.configFile, this.config);
    } catch {
      // A read-only home directory only means a new owner session next time.
    }
  }
}

async function apiError(response: Response): Promise<CliError> {
  try {
    const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message) {
      return new CliError(`${parsed.error.message} (${parsed.error.code ?? response.status})`);
    }
  } catch {
    // not JSON
  }
  return new CliError(`Server answered ${response.status} ${response.statusText}`);
}
