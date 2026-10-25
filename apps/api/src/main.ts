import { diagnosticError, diagnosticRoute } from "@codesh/shared";
import { crashDiagnosticPath, ingestCrashDiagnostic, writeCrashDiagnostic } from "@codesh/storage";
import { buildApp } from "./app.js";
import { loadConfig, proxyWarnings } from "./config.js";
import { createRuntime } from "./runtime.js";

const config = loadConfig();
const runtime = await createRuntime(config);
const crashPath = crashDiagnosticPath("api");
const diagnostics = runtime.deps.diagnostics;
if (diagnostics) ingestCrashDiagnostic(crashPath, diagnostics);
const app = buildApp(runtime.deps, {
  logger: {
    level: config.production ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    serializers: {
      err: (error: unknown) => {
        const details = diagnosticError(error);
        return {
          type: "Error",
          message: details.message ?? "Error",
          stack: details.stack ?? "",
          ...(details.code !== undefined
            ? { code: details.code }
            : details.errorCode !== undefined
              ? { code: details.errorCode }
              : {}),
        };
      },
      req: (req: {
        method: string;
        url: string;
        ip?: string;
        socket?: { remoteAddress?: string };
      }) => ({
        method: req.method,
        url: diagnosticRoute(req.url),
        remoteAddress: req.ip ?? req.socket?.remoteAddress ?? "unknown",
      }),
    },
  },
});

for (const warning of proxyWarnings(config)) app.log.warn(warning);

// Monitor preserves Node's default fatal-error behavior while recording safe diagnostic fields.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  const kind = origin === "unhandledRejection" ? "rejection" : "uncaught";
  const details = diagnosticError(error);
  writeCrashDiagnostic(crashPath, kind, details);
  runtime.deps.diagnostics?.record(kind, details, "error");
});
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
    app.log.error(diagnosticError(error));
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(diagnosticError(error));
  process.exit(1);
}
