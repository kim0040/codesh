# MongoDB optimisation evidence

Base: `35526d7` (`kim0040/sqlint` merge base); implementation branch: `kim0040/mongoopt`.

## Measurement

All installs, benchmarks, type checks and tests ran on `codesh-dev` through `scripts/box`. The box has 4 vCPU / 8 GiB RAM; Node 22.23.3, MongoDB 8.3.13 standalone, mongodb driver 7.7.0, loopback TCP. This is MongoDB 8 evidence, not a replica-set failover or WAN benchmark.

The fixture contains 20,000 shares (500-byte previews), 200,000 binary 1 KiB update entries, 20,000 snapshots, 2,000 clients, 20,000 labels and 2,000 GridFS uploads. Each timed path has 5 warmups and 40 samples, except upload streams (20 samples) and full sweeps / batch upload cleanup (5 samples). Uploads contain 64 x 1 KiB input chunks. Sweep orphan trials seed 300 orphan references in each of updates, snapshots and labels; expiry trials seed 100 expired uploads. Those two timings include fixture insertion on both revisions.

Command monitoring is enabled before opening the measured pool on both revisions. Command counts and BSON reply bytes are measured separately from timed samples. No dependency was added. The benchmark is outside src/ and is never executed by pnpm check. Its lock is a successful in-process stub, so sweep timings exclude Valkey round trips; the integration tests use real Valkey to verify locking.

| Path | Before p50 ms | Before p95 ms | After p50 ms | After p95 ms |
| --- | ---: | ---: | ---: | ---: |
| touch | 0.365 | 1.464 | 0.436 | 5.279 |
| shares.get | 0.413 | 1.273 | 0.418 | 1.479 |
| updates.append10 | 0.998 | 2.321 | 1.294 | 19.217 |
| updates.read5 | 0.557 | 5.261 | 0.486 | 1.583 |
| snapshots.latest | 0.423 | 0.795 | 0.416 | 2.672 |
| snapshots.put | 0.381 | 0.737 | 0.411 | 0.808 |
| shares.listForClient | 0.654 | 3.374 | 0.810 | 2.203 |
| labels.listForClient | 0.362 | 1.907 | 0.422 | 1.112 |
| adminList | 23.850 | 43.128 | 0.970 | 3.315 |
| adminList.search | 22.211 | 29.680 | 11.584 | 14.727 |
| adminSummary | 17.797 | 20.476 | 16.961 | 21.257 |
| files.get | 1.104 | 1.845 | 1.060 | 2.922 |
| files.openDownload | 1.076 | 2.106 | 1.039 | 2.319 |
| files.put64chunks | 22.388 | 31.056 | 22.242 | 29.656 |
| files.shareIds | 12.528 | 15.847 | 5.227 | 7.701 |
| sweep.live20k | 2035.883 | 2443.298 | 769.354 | 821.189 |
| sweep.orphans300 | 2329.961 | 2536.147 | 788.256 | 807.037 |
| files.deleteExpired100 | 83.270 | 103.567 | 28.449 | 32.161 |

The shared box showed variable tail latency, including unchanged append/touch/snapshot paths. No improvement is claimed for those paths. The large improvements below are also supported by document counts, command counts and response sizes; these are not production latency promises.

| Diagnostic operation | Commands before / after | BSON reply bytes before / after |
| --- | ---: | ---: |
| updates.read5 | 1 / 1 | 5,622 / 5,352 |
| files.put64chunks | 70 / 69 | 6,771 / 2,418 |
| files.shareIds | 2 / 1 | 387,756 / 42,916 |
| sweep.live20k | 4016 / 1053 | 40,935,518 / 8,599,263 |
| files.deleteExpired100 | 401 / 103 | 38,372 / 11,037 |

## Changes and evidence

- `packages/storage/src/mongo.ts`: add only `shares.createdAt_id_desc` (`createdAt: -1, _id: -1`). Before, unfiltered adminList scanned 20,000 keys/documents and performed a blocking SORT for 100 results. After, it scans 100 keys/documents using the new index without a blocking sort. p50/p95 changed from 23.850/43.128 ms to 0.970/3.315 ms. Literal substring search still scans matching candidates and retains exactly the existing matching/pagination rules; measured search changed from 22.211/29.680 to 11.584/14.727 ms.
- `mongo.ts`: project update reads to seq/data only. The existing unique shareId_seq index still examines exactly 5 keys/documents for 5 returned updates; BSON reply size falls from 5,622 to 5,352 bytes. p50/p95 changed from 0.557/5.261 to 0.486/1.583 ms. Append ordering, rollback on duplicate sequences and Binary conversion are unchanged.
- `mongo.ts`: quota reservation uses conditional updateOne and matchedCount instead of returning a document from findOneAndUpdate. Both are single atomic conditional increments. The 64-chunk upload/delete workload changes from 22.388/31.056 to 22.242/29.656 ms and 6,771 to 2,418 reply bytes (this combined reply reduction also includes atomic file deletion). Chunk-by-chunk reservation, capacity errors, draining and rollback semantics remain covered by the unchanged contract.
- `mongo.ts`: file shareIds uses MongoDB distinct instead of fetching all file metadata. 2,000 uploads change from 12.528/15.847 to 5.227/7.701 ms; replies fall from 387,756 to 42,916 bytes and 2 commands to 1.
- `mongo.ts`: GridFS expiry/orphan cleanup reads IDs through a cursor in batches of 256, atomically claims file metadata with at most 8 concurrent findOneAndDelete calls, then deletes chunks in one operation and debits the quota ledger once per batch. Only claimed records debit the ledger, preventing concurrent new-code cleanup requests from charging the same file twice. 100-file expiry changes from 83.270/103.567 to 28.449/32.161 ms and 401 to 103 commands. Existing bulk deletion return counts continue to count the initial selected file IDs.
- `mongo.ts`: MongoMaintenance replaces database-wide share ID arrays and per-client label N+1 reads with index-backed aggregate cursors and 256-ID existence/cleanup batches. Each source is scanned sequentially, and all references to an orphan are removed before scanning the next source, preserving the unique orphan count. The update source uses PROJECTION_COVERED -> DISTINCT_SCAN: 20,000 keys, zero documents for 200,000 entries. Accessible-label pages fetch only _id/ownerId/savedBy, and deleteMany matches the observed full label records so a concurrent replacement survives this pass. Live sweep p50/p95 changes from 2035.883/2443.298 to 769.354/821.189 ms; 300-orphan sweeps from 2329.961/2536.147 to 788.256/807.037 ms. Live sweep commands drop 4,016 -> 1,053 and reply bytes 40,935,518 -> 8,599,263.
- `mongo.ts`: expiry and retention deletes use cursor batches of at most 256 IDs, rechecking the original filter before deletion. Upload batches and every maintenance page renew the sweeper lease. Cursors close in finally blocks; lease loss stops subsequent work and the outer sweeper releases the lock. Total sweep work still scales with all references, preserving cleanup completeness; batch size bounds client memory and each deletion, not total runtime. MongoDB may spill a grouping fallback to disk if an index cannot serve it.
- `apps/collab/src/sweeper.ts`, `packages/storage/src/types.ts`: feature-detect the optional maintenance hook. This four-line type extension was explicitly approved by the coordinator. The original SQL/memory expiry, shareIds, existing, deleteForShare, deleteInaccessible and per-client label fallback calls remain intact. No SQL or deploy source changed.
- `mongo.test.ts`, `sweeper.test.ts`: add populated-index upgrade/idempotency, multiple orphan pages and unique counts, accessible labels, 301-file concurrent cleanup/quota preservation, expiry/retention batch renewal and touch-after-selection preservation, concurrent label replacement, hook selection, fallback selection and lease-loss coverage. The shared storeContract source and existing assertions remain intact; the existing ensureIndexes test gains an assertion for the additive index.

## Index and connection decisions

All legacy indexes are retained, including ownerId, savedBy, labId, TTL, both share-ID snapshot indexes and GridFS indexes. The new index is non-unique and additive; ensureIndexes is idempotent against populated collections. MongoDB 8 online createIndexes coordinates its own brief start/commit locks and concurrent build phase; no deprecated background flag or index drop is used. Older API/collab processes can continue using their original indexes during a rolling update. Startup still awaits index creation, and operators should allow normal index-build disk/memory headroom. [MongoDB online index builds](https://www.mongodb.com/docs/manual/core/index-creation/).

Other explains: share get uses one _id EXPRESS_IXSCAN document; update reads use shareId_seq with exactly the returned key count; latest snapshots use the reverse unique shareId_kind_seq scan for one document; label list uses clientId for 10 documents. listForClient uses ownerId/savedBy OR scans over only 20 matching documents with a small sort. Adding updatedAt compound indexes would increase touch write cost without a measured bottleneck. Array-returning Stores methods (update read, listForClient and snapshot metadata lists) still return complete results; arbitrary limits would change the contract. Maintenance avoids those array APIs instead of truncating them. AdminSummary still performs an exact live-share aggregate (17.797/20.476 -> 16.961/21.257 ms); an exact count necessarily visits live rows, and no stale cache or new write-heavy covering index was introduced. labId has zero usage in this fixture, which does not exercise labs, so it is not evidence that the production index is unused.

connectMongo is unchanged: maxPoolSize=100, minPoolSize=0, maxConnecting=2, serverSelectionTimeoutMS=10,000 (existing caller override retained), connectTimeoutMS=30,000, socketTimeoutMS=0, waitQueueTimeoutMS=0, retryReads=true, retryWrites=true, primary read preference and no compression by default. The bounded cleanup concurrency is 8, so this measurement does not justify a larger or permanently warm pool. Shorter timeouts or disabling retry would introduce new failure modes; shrinking the pool has no demonstrated benefit. [Driver pool settings](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/).

No writeConcern/readConcern is overridden: existing URI and server durability policy, including majority/journal settings where configured, continues to apply to normal collections, quota writes and direct GridFS cleanup. The measured plain standalone URI does not itself prove majority replication or journal acknowledgement. This task does not claim a crash/failover durability upgrade. Operators needing explicit guarantees should retain their majority/journaled policy and validate it on their replica set; do not adopt w:1 or journal:false as a performance change. [Write concern](https://www.mongodb.com/docs/manual/reference/write-concern/).

Compression stays opt-in. Built-in zlib is available without a new dependency, but the loopback fixture does not establish a network bottleneck or justify spending CPU on it. Snappy/Zstandard dependencies were not added. [Driver compression](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/network-compression/).

## Reproduction

After scripts/box pnpm install --frozen-lockfile, run the benchmark independently from pnpm check:

```sh
scripts/box 'flock /tmp/codesh-bench-mongo.lock pnpm --filter @gachipad/collab exec tsx ../../packages/storage/bench-mongo.ts after'
```

For the original implementation, save `git show 35526d7:packages/storage/src/mongo.ts` to `packages/storage/src/.mongo-before.ts`, run the same command with `MONGO_BENCH_IMPL=./src/.mongo-before.ts` before pnpm, then remove that temporary file. The benchmark only accesses the hardcoded throwaway database `codesh_bench_mongo`; it drops it before seeding and again in finally. Serialize benchmark runs with the named flock. Initial connection failure does not create a database. Raw current-run output is in `.box-out/mongo-before.json` and `.box-out/mongo-after.json` (ignored, synthetic data only).

## Validation

- `scripts/box pnpm install --frozen-lockfile`: PASS.
- Standalone benchmark strict check on the box: PASS, `pnpm exec tsc --project .box-out/tsconfig-mongo-bench.json`. The temporary config extends tsconfig.base.json, enables Node types and includes packages/storage/bench-mongo.ts; all strict/noUncheckedIndexedAccess settings apply. Benchmark Biome check: PASS with no diagnostics.
- Final `scripts/box pnpm check`: PASS, 91 files passed / 19 skipped; 942 tests passed / 464 skipped; all 10 package typecheck tasks and license gate passed. Biome reports 6 existing warnings and 2 infos outside this ownership (ShareDialog.tsx, deploy/verify-security.mjs, web cross-OS specs and shared diagnostics); the gate exits zero, and the changed code has no Biome diagnostics.
- `scripts/box 'GACHIPAD_REQUIRE_SERVICES=1 pnpm --filter @gachipad/storage test'`: PASS, 4 files; 185 passed / 174 SQL-service opt-in cases skipped. MongoDB suite: 41/41 passed, including the unchanged 32-test shared contract.
- `scripts/box 'pnpm --filter @gachipad/api test'`: PASS, first phase 28 files / 335 tests; real collab integration phase 1 file / 8 tests (343 passed total). The package script enables GACHIPAD_INTEGRATION=1 and deliberately runs real collab integration separately. VALKEY_URL was not assigned a database number.
- `scripts/box 'pnpm --filter @gachipad/collab test'`: PASS, 16 files / 102 tests, including 7 sweeper tests.
- `scripts/box 'flock /tmp/codesh-bench-mongo.lock ...'`: PASS on baseline and final implementation, with both JSON outputs parsed and nonzero command-monitoring assertions verified. The temporary baseline module was removed after measurement. A final listDatabases query verified codesh_bench_mongo was absent, and a separate process query found no remaining processes under this worktree on the box.

## Remaining evidence boundaries

MongoDB 8.0 specifically, a multi-node replica set, process-kill fault injection during a GridFS deletion batch, sustained pool saturation and WAN compression were not exercised. GridFS chunks/metadata/quota remain multiple durable operations, as before; a process failure between them can leave conservative quota/chunk residue. Atomic file claims prevent duplicate quota release among the new deletion paths; a concurrently running old binary retains its old deletion race. No persistent service process was started by this worker, no service or database outside throwaway benchmark/test namespaces was removed, and no push/deploy was performed.
