import { openInBrowser, run } from "./run.js";

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  stdinIsTTY: process.stdin.isTTY === true,
  openBrowser: (url, platform) => openInBrowser(url, platform),
});
