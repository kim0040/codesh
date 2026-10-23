import { createCollabServer } from "./server.js";

const port = Number(process.env.PORT ?? 3002);
const server = createCollabServer({ port, address: process.env.HOST ?? "0.0.0.0" });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  try {
    await server.destroy();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await server.listen();
