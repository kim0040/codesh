import { Agent, request } from "undici";

/** One browser: its own `codesh_sid` cookie, talking to the API through a shared connection pool. */
export class ApiClient {
  /** `codesh_sid=...`, so another thread can act as the same person. */
  cookie = "";

  constructor(
    private readonly base: string,
    private readonly agent: Agent,
    private readonly onRateLimited: () => void,
    cookie = "",
  ) {
    this.cookie = cookie;
  }

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    for (let attempt = 0; ; attempt++) {
      const response = await request(`${this.base}${path}`, {
        method,
        dispatcher: this.agent,
        headers: {
          // The API refuses non-GET requests without it (apps/api/README.md, "Cross-site requests").
          ...(method === "GET" ? {} : { "x-codesh": "1" }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers["set-cookie"];
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (first) this.cookie = first.split(";")[0] as string;
      const text = await response.body.text();
      if (response.statusCode === 429 && attempt < 8) {
        this.onRateLimited();
        await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** Math.min(attempt, 4)));
        continue;
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: response.statusCode, json: json as T };
    }
  }
}

export function createAgent(connections: number): Agent {
  return new Agent({ connections, keepAliveTimeout: 30_000, pipelining: 1 });
}
