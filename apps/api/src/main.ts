import { buildApp } from "./app.js";
import { loadConfig, proxyWarnings } from "./config.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const app = buildApp(runtime.deps, {
  logger: { level: config.production ? "info" : "debug" },
});

for (const warning of proxyWarnings(config)) app.log.warn(warning);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await runtime.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
