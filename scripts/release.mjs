// Release checks and notes (RELEASING.md). No dependencies; runs in CI and on a laptop.
//
//   node scripts/release.mjs check [vX.Y.Z]   the version is the same everywhere (and equals the tag)
//   node scripts/release.mjs notes X.Y.Z [--footer owner/repo]
//                                             prints the CHANGELOG.md section of that version, with
//                                             the update and verification steps for a release page
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** The lines under `## [version] - date` up to the next `## ` heading or the link list. */
export function changelogSection(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const heading = lines[start];
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ") || /^\[[^\]]+\]: /.test(line)) break;
    body.push(line);
  }
  return { heading, body: body.join("\n").trim() };
}

const [command, argument, flag, repo] = process.argv.slice(2);
const version = JSON.parse(read("package.json")).version;

if (command === "check") {
  if (!SEMVER.test(version)) fail(`package.json version ${version} is not X.Y.Z`);
  if (argument !== undefined && argument.replace(/^refs\/tags\//, "") !== `v${version}`)
    fail(`tag ${argument} does not match package.json version ${version}: bump it first`);
  const envVersion = /^CODESH_VERSION=(.*)$/m.exec(read("deploy/.env.example"))?.[1];
  if (envVersion !== version)
    fail(`deploy/.env.example has CODESH_VERSION=${envVersion}, package.json has ${version}`);
  const section = changelogSection(read("CHANGELOG.md"), version);
  if (!section) fail(`CHANGELOG.md has no "## [${version}]" section`);
  if (!/ - \d{4}-\d{2}-\d{2}$/.test(section.heading))
    fail(`CHANGELOG.md: "${section.heading}" needs a release date (## [${version}] - YYYY-MM-DD)`);
  if (!section.body) fail(`CHANGELOG.md: the ${version} section is empty`);
  console.log(`release: ${version} is consistent (package.json, deploy/.env.example, CHANGELOG.md)`);
} else if (command === "notes") {
  const section = changelogSection(read("CHANGELOG.md"), argument ?? version);
  if (!section) fail(`CHANGELOG.md has no section for ${argument ?? version}`);
  process.stdout.write(`${section.body}\n`);
  if (flag === "--footer") {
    const v = argument ?? version;
    process.stdout.write(
      [
        "",
        "---",
        "",
        `Online: run \`./update.sh\` in the codesh folder. Offline: download \`codesh-${v}-linux-amd64.tar.gz\` (or \`-linux-arm64\`) and its \`.sha256\`, then run \`./upgrade.sh codesh-${v}-linux-amd64.tar.gz\`.`,
        `Verify a download or an image: \`gh attestation verify <file> --repo ${repo}\`, \`gh attestation verify oci://ghcr.io/${repo.split("/")[0].toLowerCase()}/codesh-api:${v} --repo ${repo}\`.`,
        "",
      ].join("\n"),
    );
  }
} else {
  fail("usage: node scripts/release.mjs check [vX.Y.Z] | notes X.Y.Z");
}
