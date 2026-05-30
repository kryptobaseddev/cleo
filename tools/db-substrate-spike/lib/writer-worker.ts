/**
 * Worker-thread body for the concurrency benchmark (T11322).
 *
 * Each worker simulates one independent CLI process: it opens its OWN
 * `DatabaseSync` handle against the shared consolidated file (multi-process
 * contention is the real CLEO profile — concurrent `verify`/`complete`/`add`
 * invocations), applies the mandatory pragma set, and commits one INSERT every
 * `intervalMs` for `durationMs`. Per-commit latency (BEGIN→COMMIT wall time) is
 * captured and posted back to the parent on exit.
 *
 * ## Self-contained by design
 *
 * This module has ZERO relative imports. Worker threads launched with the tsx
 * loader (`--import tsx/esm`) correctly transpile the worker entry itself but
 * do NOT rewrite nested `./x.js` → `./x.ts` specifiers (a documented tsx
 * worker-thread limitation on Node 24). Inlining the pragma + open logic here
 * — rather than importing `./open.js` / `./pragmas.js` — sidesteps that
 * resolution gap while keeping every other harness file on the repo's ESM
 * `.js`-suffix convention. The inlined pragma set is byte-identical to
 * {@link file://./pragmas.ts} `SPIKE_PRAGMAS`.
 *
 * @task T11322
 * @saga T11242
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

/** Parameters passed from the parent to each writer worker. */
export interface WriterWorkerData {
  /** Absolute path to the shared consolidated DB file. */
  dbPath: string;
  /** Unique worker index (used to namespace inserted row ids). */
  workerId: number;
  /** Target write interval per worker (ms) — 10/s ⇒ 100ms. */
  intervalMs: number;
  /** Total run duration (ms). */
  durationMs: number;
  /** Table to write into (`telemetry_span`). */
  table: string;
}

/** Result posted back to the parent when a worker finishes. */
export interface WriterWorkerResult {
  workerId: number;
  /** Per-commit BEGIN→COMMIT latencies in ms. */
  latencies: number[];
  /** Count of SQLITE_BUSY (or other) errors encountered. */
  errors: number;
  /** Total commits attempted. */
  commits: number;
}

/**
 * Inlined mandatory consolidation pragma set — byte-identical to
 * `SPIKE_PRAGMAS` in `./pragmas.ts`. See the module docblock for why this is
 * inlined rather than imported.
 */
const PRAGMAS: ReadonlyArray<readonly [string, string]> = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['busy_timeout', '30000'],
  ['wal_autocheckpoint', '1000'],
  ['foreign_keys', 'ON'],
];

const require_ = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

/** Open the consolidated file with the mandatory pragma set applied. */
function openWithPragmas(path: string): DatabaseSync {
  const { DatabaseSync: Ctor } = require_('node:sqlite') as NodeSqliteModule;
  const db = new Ctor(path);
  for (const [name, value] of PRAGMAS) {
    db.exec(`PRAGMA ${name} = ${value};`);
  }
  return db;
}

/** Sleep helper that yields the event loop without busy-waiting. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the writer loop. Exported for unit testing; auto-invoked when this module
 * is the worker entrypoint (i.e. `workerData` is present).
 *
 * @param data - The {@link WriterWorkerData}.
 * @returns The {@link WriterWorkerResult}.
 */
export async function runWriter(data: WriterWorkerData): Promise<WriterWorkerResult> {
  const db = openWithPragmas(data.dbPath);
  const insert = db.prepare(
    `INSERT INTO ${data.table} (id, task_id, duration_ms, payload) VALUES (?, ?, ?, ?)`,
  );
  const latencies: number[] = [];
  let errors = 0;
  let commits = 0;

  const start = performance.now();
  let seq = 0;
  while (performance.now() - start < data.durationMs) {
    const id = `w${data.workerId}-${seq++}`;
    const t0 = performance.now();
    try {
      // Explicit BEGIN IMMEDIATE/COMMIT — node:sqlite has no transaction()
      // helper. This BEGIN→COMMIT span is the "commit latency" the AC measures.
      db.exec('BEGIN IMMEDIATE;');
      insert.run(id, `T${data.workerId}`, seq, '{"k":"v"}');
      db.exec('COMMIT;');
      latencies.push(performance.now() - t0);
      commits++;
    } catch {
      errors++;
      try {
        db.exec('ROLLBACK;');
      } catch {
        // best-effort
      }
    }
    // Pace to the target rate; subtract elapsed so the rate is honored.
    const elapsed = performance.now() - t0;
    const wait = data.intervalMs - elapsed;
    if (wait > 0) await sleep(wait);
  }

  db.close();
  return { workerId: data.workerId, latencies, errors, commits };
}

// Auto-run when launched as a worker thread.
if (parentPort && workerData) {
  const data = workerData as WriterWorkerData;
  runWriter(data)
    .then((result) => {
      parentPort?.postMessage(result);
    })
    .catch((err: unknown) => {
      parentPort?.postMessage({
        workerId: (workerData as WriterWorkerData).workerId,
        latencies: [],
        errors: -1,
        commits: 0,
        fatal: err instanceof Error ? err.message : String(err),
      });
    });
}
