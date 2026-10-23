import { type Extension, Server } from "@hocuspocus/server";

export const COLLAB_PATH = "/collab";

export interface CollabOptions {
  port: number;
  address?: string;
  quiet?: boolean;
}

/** Serves `GET /healthz` and only accepts WebSocket upgrades on `/collab`. */
const routes: Extension = {
  extensionName: "routes",
  async onRequest({ request, response }) {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/healthz") {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } else {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true }));
    }
    // A rejection without an error stops Hocuspocus from sending its default reply.
    return Promise.reject();
  },
  async onUpgrade({ request, socket }) {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== COLLAB_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return Promise.reject();
    }
  },
};

export function createCollabServer({ port, address, quiet }: CollabOptions): Server {
  return new Server({
    port,
    address,
    quiet,
    // Shutdown is owned by main.ts so that later extensions can flush before exit.
    stopOnSignals: false,
    extensions: [routes],
  });
}
