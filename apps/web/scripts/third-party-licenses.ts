/**
 * Licence texts of the web build. Vite minifies the bundle and strips the licence comments of the
 * packages in it, so the build writes them next to it instead:
 *
 *   dist/THIRD-PARTY-LICENSES.txt   every package of the web production closure, plus the Linguist
 *                                   licence (language colours) and Prettier's bundled notices
 *   dist/licenses/OFL-*.txt         the SIL Open Font Licence texts of the two fonts
 *
 * The closure is walked from apps/web/package.json (dependencies and optionalDependencies, through
 * the workspace packages), because `pnpm licenses --filter` does not follow workspace links. The
 * output has no dates or absolute paths, so the same lockfile gives the same bytes. The build fails
 * for a package without licence text unless NO_LICENSE_FILE names it.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";

export interface LicenseFile {
  name: string;
  text: string;
}

export interface ClosurePackage {
  name: string;
  version: string;
  /** The `license` field of package.json, as declared. */
  license: string;
  repository: string | undefined;
  author: string | undefined;
  files: LicenseFile[];
}

/**
 * Packages whose tarball has no licence file. The value is the licence their package.json declares;
 * a different declaration (an update that changes it) fails the build until the entry is reviewed.
 */
export const NO_LICENSE_FILE: ReadonlyMap<string, string> = new Map([
  ["react-remove-scroll-bar", "MIT"],
]);

/** Licence files that are not in the package root (the root has none). */
const EXTRA_LICENSE_FILES: ReadonlyMap<string, readonly string[]> = new Map([
  ["pretendard", ["dist/LICENSE.txt"]],
]);

/** The two fonts: package, licence file inside it, name of the copy under dist/licenses/. */
export const FONT_LICENSES = [
  { name: "pretendard", file: "dist/LICENSE.txt", out: "licenses/OFL-pretendard.txt" },
  {
    name: "@fontsource-variable/jetbrains-mono",
    file: "LICENSE",
    out: "licenses/OFL-jetbrains-mono.txt",
  },
] as const;

const LICENSE_FILE =
  /^(licen[cs]es?|copying|unlicen[cs]e|notices?|third[-_ ]party[-_ ]notices?|patents)([-._ ].*)?$/i;

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  author?: string | { name?: string };
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Node's resolution on real paths: the pnpm store keeps a package's dependencies as siblings. */
function resolvePackage(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      if (isFile(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function declaredLicense(pkg: PackageJson): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  const types = (pkg.licenses ?? []).map((l) => l.type).filter(Boolean);
  return types.length > 0 ? types.join(" OR ") : "UNKNOWN";
}

function repositoryUrl(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return undefined;
  const url = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  return /^[\w-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

function authorName(pkg: PackageJson): string | undefined {
  return typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
}

function normalize(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function licenseFiles(name: string, dir: string): LicenseFile[] {
  const found = readdirSync(dir)
    .filter((entry) => LICENSE_FILE.test(entry) && isFile(join(dir, entry)))
    .sort();
  const extra = (EXTRA_LICENSE_FILES.get(name) ?? []).filter((entry) => isFile(join(dir, entry)));
  return [...found, ...extra].map((entry) => ({
    name: entry,
    text: normalize(readFileSync(join(dir, entry), "utf8")),
  }));
}

/**
 * Every package a production install of `entryDir` puts on disk: its dependencies and optional
 * dependencies, transitively, through workspace packages (which are not listed themselves).
 * Optional dependencies that are not installed on this platform are skipped.
 */
export function collectClosure(entryDir: string): ClosurePackage[] {
  const root = realpathSync(entryDir);
  const seen = new Set<string>();
  const found = new Map<string, ClosurePackage>();
  const queue = [root];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readJson(join(dir, "package.json"));
    const external = dir.split(sep).includes("node_modules");
    if (external && pkg.name && pkg.version) {
      const files = licenseFiles(pkg.name, dir);
      const license = declaredLicense(pkg);
      if (files.length === 0 && NO_LICENSE_FILE.get(pkg.name) !== license) {
        throw new Error(
          `${pkg.name}@${pkg.version} (${license}) ships no licence text; add it to NO_LICENSE_FILE after checking it`,
        );
      }
      found.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license,
        repository: repositoryUrl(pkg),
        author: authorName(pkg),
        files,
      });
    }
    for (const [group, deps] of [
      ["dependencies", pkg.dependencies],
      ["optionalDependencies", pkg.optionalDependencies],
    ] as const) {
      for (const name of Object.keys(deps ?? {}).sort()) {
        const next = resolvePackage(name, dir);
        if (next) queue.push(next);
        else if (group === "dependencies") {
          throw new Error(`${name} (dependency of ${pkg.name ?? dir}) is not installed`);
        }
      }
    }
  }
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
}

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

/** The text of dist/THIRD-PARTY-LICENSES.txt. */
export function renderLicenses(packages: ClosurePackage[], linguist: string): string {
  const out: string[] = [
    "codesh third-party licences",
    "",
    "codesh itself is MIT-licensed (Copyright (c) 2026 Hyunmin Kim). This file reproduces the licence",
    "texts and notices of the open-source software in this web app: the npm packages of its",
    "production dependency tree, the GitHub Linguist language colours, and the notices Prettier ships",
    "for the components it bundles. The two fonts have their own texts in /licenses/.",
    "Licence texts of the server components and container images: THIRD_PARTY_NOTICES.md in the",
    "source repository and in /usr/share/doc/codesh/ of the images.",
    "",
    `Packages (${packages.length}):`,
    ...packages.map((p) => `  ${p.name}@${p.version}  ${p.license}`),
    "",
  ];
  const section = (title: string, lines: string[]) => out.push(RULE, title, ...lines, THIN, "");
  section("GitHub Linguist (language colours)", [
    "License: MIT",
    "Source: https://github.com/github-linguist/linguist",
    "",
    normalize(linguist),
  ]);
  for (const pkg of packages) {
    const head = [`License: ${pkg.license}`];
    if (pkg.repository) head.push(`Source: ${pkg.repository}`);
    if (pkg.author) head.push(`Author: ${pkg.author}`);
    const body =
      pkg.files.length > 0
        ? pkg.files.flatMap((file) => ["", `--- ${file.name} ---`, file.text])
        : [
            "",
            `This package ships no licence file; its package.json declares the licence ${pkg.license}.`,
          ];
    section(`${pkg.name}@${pkg.version}`, [...head, ...body]);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Writes dist/THIRD-PARTY-LICENSES.txt and dist/licenses/OFL-*.txt after the bundle is written. */
export function thirdPartyLicenses(): Plugin {
  let root = process.cwd();
  return {
    name: "codesh:third-party-licenses",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async writeBundle(options) {
      const outDir = resolve(root, options.dir ?? "dist");
      const packages = collectClosure(root);
      const linguist = readFileSync(join(root, "scripts/licenses/github-linguist.txt"), "utf8");
      await mkdir(join(outDir, "licenses"), { recursive: true });
      await writeFile(join(outDir, "THIRD-PARTY-LICENSES.txt"), renderLicenses(packages, linguist));
      for (const font of FONT_LICENSES) {
        const pkg = packages.find((p) => p.name === font.name);
        const file = pkg?.files.find((f) => f.name === font.file);
        if (!file)
          throw new Error(`${font.name}: ${font.file} is missing; cannot write ${font.out}`);
        await writeFile(join(outDir, font.out), `${file.text}\n`);
      }
    },
  };
}
