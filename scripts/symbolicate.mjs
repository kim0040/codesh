#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, join, normalize, resolve, sep } from "node:path";

const [exportPath, mapsPath] = process.argv.slice(2);
if (!exportPath || !mapsPath) {
  console.error("usage: node scripts/symbolicate.mjs <export.json> <sourcemaps dir>");
  process.exit(2);
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const mapCache = new Map();

function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("invalid source map VLQ");
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) === 0) {
      const negative = (value & 1) === 1;
      values.push(negative ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  if (shift !== 0) throw new Error("truncated source map VLQ");
  return values;
}

function sourcePath(map, source) {
  const joined = normalize(join(map.sourceRoot ?? "", source))
    .split(sep)
    .join("/");
  return joined.replace(/^(\.\.\/)+/, "");
}

function sourcePosition(file, line, column) {
  const name = basename(file);
  const candidates = [join(mapsPath, "assets", `${name}.map`), join(mapsPath, `${name}.map`)];
  const mapFile = candidates.find(existsSync);
  if (!mapFile) return null;
  let map = mapCache.get(mapFile);
  if (!map) {
    map = JSON.parse(readFileSync(mapFile, "utf8"));
    mapCache.set(mapFile, map);
  }

  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const wantedLine = Number(line);
  const wantedColumn = Number(column) - 1;
  let best = null;
  const lines = map.mappings.split(";");
  for (let generatedLine = 0; generatedLine < Math.min(wantedLine, lines.length); generatedLine++) {
    let generatedColumn = 0;
    let lineBest = null;
    for (const segment of lines[generatedLine].split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue;
      source += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      if (generatedLine + 1 === wantedLine && generatedColumn <= wantedColumn)
        lineBest = { generatedColumn, source, originalLine, originalColumn };
      if (generatedLine + 1 === wantedLine && generatedColumn > wantedColumn) break;
    }
    if (generatedLine + 1 === wantedLine) best = lineBest;
  }
  if (!best || best.source < 0 || best.source >= map.sources.length) return null;
  return {
    file: sourcePath(map, map.sources[best.source]),
    line: best.originalLine + 1,
    column: best.originalColumn + 1,
  };
}

function rewriteFrame(frame) {
  return frame.replace(
    /(\/assets\/([\w.-]+\.js)):(\d+):(\d+)/g,
    (whole, file, _name, line, column) => {
      const position = sourcePosition(file, line, column);
      return position ? `${position.file}:${position.line}:${position.column}` : whole;
    },
  );
}

const data = JSON.parse(readFileSync(resolve(exportPath), "utf8"));
for (const event of Array.isArray(data.events) ? data.events : []) {
  const details = event?.details;
  if (!details || typeof details !== "object") continue;
  if (typeof details.stack === "string")
    details.stack = details.stack.split("\n").map(rewriteFrame).join("\n");
  if (typeof details.location === "string") details.location = rewriteFrame(details.location);
}
process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
