/** Run on the dev box with `pnpm --filter @codesh/collab exec tsx src/permission-benchmark.ts`. */
import { performance } from "node:perf_hooks";
import { participantPermissions, YDOC } from "@codesh/shared";
import * as Y from "yjs";
import { validCommentAuthors } from "./comments.js";
import { hasNewOperations, permitsUpdate } from "./update-permissions.js";

const doc = new Y.Doc();
for (let i = 0; i < 100; i++) {
  const entry = new Y.Map();
  doc.getMap(YDOC.files).set(String(i), entry);
  entry.set("path", `${i}.ts`);
  entry.set("language", "typescript");
  doc.getText(YDOC.fileText(String(i))).insert(0, "x".repeat(10000));
}
const client = new Y.Doc();
Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
const vector = Y.encodeStateVector(doc);
client.getText(YDOC.fileText("0")).insert(5000, "a");
const update = Y.encodeStateAsUpdate(client, vector);
const permissions = participantPermissions();
const author = { clientId: "benchmark" };
const iterations = 30000;
function measure(name: string, run: () => void) {
  for (let i = 0; i < 3000; i++) run();
  const samples: number[] = [];
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const at = performance.now();
    run();
    samples.push((performance.now() - at) * 1000);
  }
  const meanUs = ((performance.now() - started) * 1000) / iterations;
  samples.sort((a, b) => a - b);
  return {
    name,
    meanUs,
    p50Us: samples[Math.floor(samples.length * 0.5)],
    p95Us: samples[Math.floor(samples.length * 0.95)],
  };
}
const results = [
  measure("comment guard alone (decode included)", () => {
    if (!validCommentAuthors(doc, update, author)) throw new Error("unexpected");
  }),
  measure("editor decode + new-operations + classifier + comment guard", () => {
    const decoded = Y.decodeUpdate(update);
    if (
      !hasNewOperations(doc, decoded) ||
      !permitsUpdate(doc, decoded, permissions) ||
      !validCommentAuthors(doc, update, author, decoded)
    )
      throw new Error("unexpected");
  }),
];
console.log(
  JSON.stringify(
    {
      node: process.version,
      files: 100,
      textBytes: 1000000,
      updateBytes: update.byteLength,
      iterations,
      results,
    },
    null,
    2,
  ),
);
client.destroy();
doc.destroy();
