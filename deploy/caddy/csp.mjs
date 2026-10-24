// Hash only inline scripts in the trusted production entry point (e.g. the theme bootstrap).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const html = await readFile("apps/web/dist/index.html", "utf8");
const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes, body]) => !/\bsrc\s*=/i.test(attributes) && body.trim())
  .map(([, , body]) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`);
const config = await readFile("deploy/caddy/Caddyfile", "utf8");
await writeFile(
  "Caddyfile.production",
  config.replace("{$CSP_SCRIPT_HASHES}", [...new Set(hashes)].join(" ")),
);
