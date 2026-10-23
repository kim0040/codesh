// Fails when an installed package has a license outside the allowlist of docs/ARCHITECTURE.md §13.
// Usage: pnpm run licenses   (runs `pnpm licenses list --json` for prod and dev dependencies)
import { execFileSync } from "node:child_process";

const COMMON = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "OFL-1.1", // fonts
  "CC-BY-4.0", // data only (caniuse-lite)
];

const ALLOWED = {
  prod: new Set(COMMON),
  // Python-2.0 (argparse) is accepted for tooling only.
  dev: new Set([...COMMON, "Python-2.0"]),
};

// Packages outside the allowlist that the mandated stack needs. Keep this list short and explain each entry.
const EXCEPTIONS = {
  prod: new Set(["Unlicense"]), // isbot (public domain), dependency of @tanstack/react-router
  dev: new Set(["Unlicense", "MPL-2.0"]), // lightningcss (build-time only, unmodified), dependency of Tailwind v4
};

// Single packages whose package.json license field is wrong. Keyed by name@version so an update is re-checked.
const PACKAGE_EXCEPTIONS = new Set([
  // package.json says "UNLICENSED" but LICENSE.md is MIT (fork of mike-marcacci/redlock); dependency of @hocuspocus/extension-redis
  "@sesamecare-oss/redlock@1.4.0",
]);

/**
 * Evaluates an SPDX expression: `OR` passes when any alternative is allowed,
 * `AND` needs every operand, `X WITH Y` is judged by `X`.
 */
export function isAllowed(expression, allowed) {
  const tokens = expression
    .replace(/([()])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;

  const parseOr = () => {
    let result = parseAnd();
    while (tokens[pos] === "OR") {
      pos++;
      const next = parseAnd();
      result = result || next;
    }
    return result;
  };
  const parseAnd = () => {
    let result = parseAtom();
    while (tokens[pos] === "AND") {
      pos++;
      const next = parseAtom();
      result = result && next;
    }
    return result;
  };
  const parseAtom = () => {
    const token = tokens[pos++];
    if (token === "(") {
      const result = parseOr();
      if (tokens[pos++] !== ")") throw new Error(`unbalanced parentheses in "${expression}"`);
      return result;
    }
    if (token === undefined || token === ")") throw new Error(`cannot parse "${expression}"`);
    if (tokens[pos] === "WITH") pos += 2;
    return allowed.has(token.replace(/\+$/, ""));
  };

  try {
    const result = parseOr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

function listLicenses(scope) {
  const output = execFileSync("pnpm", ["licenses", "list", "--json", `--${scope}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function findOffenders(scope, byLicense) {
  const allowed = new Set([...ALLOWED[scope], ...EXCEPTIONS[scope]]);
  const offenders = [];
  for (const [license, packages] of Object.entries(byLicense)) {
    if (isAllowed(license, allowed)) continue;
    for (const pkg of packages) {
      const versions = pkg.versions.filter((v) => !PACKAGE_EXCEPTIONS.has(`${pkg.name}@${v}`));
      if (versions.length === 0) continue;
      offenders.push({ scope, license, name: pkg.name, versions: versions.join(", ") });
    }
  }
  return offenders;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const offenders = ["prod", "dev"].flatMap((scope) => findOffenders(scope, listLicenses(scope)));
  if (offenders.length > 0) {
    console.error("Packages with licenses outside the allowlist (docs/ARCHITECTURE.md §13):");
    for (const o of offenders) {
      console.error(`  [${o.scope}] ${o.name}@${o.versions}: ${o.license}`);
    }
    process.exit(1);
  }
  console.log("licenses ok");
}
