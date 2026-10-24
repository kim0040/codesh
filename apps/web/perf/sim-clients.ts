import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { type APIRequestContext, request } from "@playwright/test";
import * as Y from "yjs";

/**
 * Simulated participants for the browser perf specs: each is a person with their own session who
 * joins a share over the collab protocol, like a browser tab without the rendering. Writers type
 * at the end of the text and move their cursor with it; viewers move their cursor around.
 */

export const PERF_URL = process.env.E2E_PERF_URL ?? "http://localhost:8850";

export interface Member {
  shareId: string;
  /** Join body: the edit key for an editor, nothing for a viewer or an owner. */
  body: Record<string, unknown>;
  writer: boolean;
  /** An existing session (a lab student who already joined), else a new one. */
  api?: APIRequestContext;
}

interface Sim {
  api: APIRequestContext;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  doc: Y.Doc;
  text: Y.Text;
  user: { clientId: string; name: string; color: string };
  writer: boolean;
}

export async function newSession(name: string): Promise<APIRequestContext> {
  const api = await request.newContext({
    baseURL: PERF_URL,
    extraHTTPHeaders: { "X-Codesh": "1" },
  });
  const response = await api.patch("/api/session", { data: { name } });
  if (!response.ok()) throw new Error(`session ${response.status()}`);
  return api;
}

export class SimClients {
  private readonly sims: Sim[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];

  static async join(members: Member[]): Promise<SimClients> {
    const clients = new SimClients();
    await Promise.all(members.map((member, i) => clients.connect(member, `sim${i + 1}`)));
    return clients;
  }

  private async connect(member: Member, name: string): Promise<void> {
    const api = member.api ?? (await newSession(name));
    const session = (await (await api.get("/api/session")).json()) as {
      clientId: string;
      name: string;
      color: string;
    };
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `${PERF_URL.replace(/^http/, "ws")}/collab?doc=${member.shareId}`,
    });
    const token = async () => {
      const joined = await api.post(`/api/shares/${member.shareId}/join`, { data: member.body });
      if (!joined.ok()) throw new Error(`join ${joined.status()}`);
      return ((await joined.json()) as { token: string }).token;
    };
    await new Promise<void>((resolve) => {
      const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: member.shareId,
        document: doc,
        token,
        onSynced: ({ state }) => {
          if (state) resolve();
        },
      });
      provider.attach();
      this.sims.push({
        api,
        provider,
        socket,
        doc,
        text: doc.getText("file:main"),
        user: { clientId: session.clientId, name: session.name, color: session.color },
        writer: member.writer,
      });
    });
  }

  /** Puts every cursor somewhere in the text, so the browser draws all of them. */
  placeCursors(): void {
    for (const sim of this.sims) this.moveCursor(sim);
  }

  /** Writers type `typeRate` keys per second; everyone else moves `cursorRate` times per second. */
  start(rates: { typeRate: number; cursorRate: number }): void {
    for (const sim of this.sims) {
      const perSecond = sim.writer ? rates.typeRate : rates.cursorRate;
      if (perSecond <= 0) continue;
      let next = 0;
      const tick = sim.writer
        ? () => {
            next = (next + 1) % WORDS.length;
            sim.doc.transact(() => sim.text.insert(sim.text.length, WORDS[next] as string));
            this.moveCursor(sim, sim.text.length);
          }
        : () => this.moveCursor(sim);
      this.timers.push(
        setTimeout(
          () => this.timers.push(setInterval(tick, 1000 / perSecond)),
          Math.random() * (1000 / perSecond),
        ),
      );
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async close(): Promise<void> {
    this.stop();
    for (const sim of this.sims) {
      sim.provider.destroy();
      sim.socket.destroy();
    }
    await Promise.all(this.sims.map((sim) => sim.api.dispose()));
  }

  /** Moves the cursor the way the editor's awareness bridge does; to a random place by default. */
  private moveCursor(sim: Sim, index = Math.floor(Math.random() * (sim.text.length + 1))): void {
    const position = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(sim.text, index),
    );
    sim.provider.awareness?.setLocalState({
      user: sim.user,
      fileId: "main",
      cursor: { anchor: position, head: position },
      viewport: { fromLine: 1, toLine: 40 },
    });
  }
}

/** Code-like keystrokes, with a new line now and then so the text grows downwards too. */
const WORDS = ["let ", "x", " = ", "1", ";", "\n", "if ", "(", "y", ") ", "{", "}", "\n"];
