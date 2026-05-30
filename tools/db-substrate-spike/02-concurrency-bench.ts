/**
 * T11322 — Concurrency + p99 commit-latency benchmark.
 *
 * Spawns N concurrent writer worker-threads (default 100), each its OWN
 * connection (simulating independent CLI processes) writing W writes/sec
 * (default 10/s) for D seconds (default 300s = 5 min) against THREE scenarios:
 *
 *   A) BASELINE-EVEN: writers spread EVENLY across 5 per-domain files. Worst
 *      case for consolidation (each file absorbs only 1/5 of the writers).
 *   B) BASELINE-SKEWED: TODAY's real distribution — ~80% of writers on the hot
 *      `tasks.db`, ~20% across 4 cooler files. The FAITHFUL migration delta.
 *   C) CONSOLIDATED: every writer funnels onto ONE consolidated WAL file
 *      (Pattern A).
 *
 * Gate (AC4): consolidated p99 commit latency <= 1.5× the FAITHFUL skewed
 * baseline p99 (the real cost of moving the cool 20% into the hot file). The
 * even-split worst-case ratio is reported separately as a conservative bound —
 * see the spike research doc's Counter-B discussion of the p99 tail.
 *
 * Knobs (env, for local-vs-CI scaling):
 *   SPIKE_WRITERS   (default 100)
 *   SPIKE_RATE_HZ   (default 10  — writes/sec per writer)
 *   SPIKE_DURATION_S(default 300 — set lower locally; CI runs the full 300)
 *
 * Run (quick local):
 *   SPIKE_DURATION_S=20 pnpm dlx tsx tools/db-substrate-spike/02-concurrency-bench.ts
 * Run (full gate, CI):
 *   pnpm dlx tsx tools/db-substrate-spike/02-concurrency-bench.ts
 *
 * @task T11322
 * @task T11244
 * @saga T11242
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openConsolidated } from './lib/open.js';
import { WRITER_BENCH_DDL } from './lib/schema.js';
import { type LatencyStats, round, summarize } from './lib/stats.js';
import type { WriterWorkerData, WriterWorkerResult } from './lib/writer-worker.js';

const WORKER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'writer-worker.ts');

/**
 * Resolve the tsx ESM loader entry so worker threads can execute the `.ts`
 * worker body (workers do NOT inherit the parent's `--import tsx/esm`
 * registration; we re-register it via `execArgv`).
 */
const TSX_ESM = createRequire(import.meta.url).resolve('tsx/esm');
const WORKER_EXEC_ARGV = ['--import', TSX_ESM];

const WRITERS = Number(process.env['SPIKE_WRITERS'] ?? 100);
const RATE_HZ = Number(process.env['SPIKE_RATE_HZ'] ?? 10);
const DURATION_S = Number(process.env['SPIKE_DURATION_S'] ?? 300);
const INTERVAL_MS = 1000 / RATE_HZ;
const DURATION_MS = DURATION_S * 1000;

/** The five domains CLEO consolidates — used to shard the baseline layout. */
const DOMAINS = ['tasks', 'brain', 'conduit', 'docs', 'telemetry'] as const;

/** Aggregate result of one benchmark scenario. */
interface ScenarioResult {
  scenario: string;
  fileLayout: string;
  stats: LatencyStats;
  totalCommits: number;
  totalErrors: number;
  observedThroughputHz: number;
}

/**
 * Spawn the writer pool and aggregate every worker's per-commit latencies.
 *
 * The `assignPath(workerId)` callback maps each writer to a DB file. For the
 * BASELINE this round-robins writers across five SEPARATE per-domain files
 * (today's layout — contention spreads across files). For the CONSOLIDATED
 * scenario every writer maps to the SAME single file (Pattern A — all
 * contention funnels onto one WAL). This is the faithful apples-to-apples
 * comparison the AC requires: same writer count + rate + duration, only the
 * file topology differs.
 *
 * @param scenario - Label for the scenario.
 * @param fileLayout - Human-readable description of the file topology.
 * @param assignPath - Maps a writer index to its target DB file path.
 * @returns The aggregated {@link ScenarioResult}.
 */
async function runScenario(
  scenario: string,
  fileLayout: string,
  assignPath: (workerId: number) => string,
): Promise<ScenarioResult> {
  // Seed schema into every distinct file the workers will touch.
  const seeded = new Set<string>();
  for (let i = 0; i < WRITERS; i++) {
    const p = assignPath(i);
    if (!seeded.has(p)) {
      const seed = openConsolidated(p);
      seed.exec(WRITER_BENCH_DDL);
      seed.close();
      seeded.add(p);
    }
  }

  const workers: Promise<WriterWorkerResult>[] = [];
  for (let i = 0; i < WRITERS; i++) {
    const workerData: WriterWorkerData = {
      dbPath: assignPath(i),
      workerId: i,
      intervalMs: INTERVAL_MS,
      durationMs: DURATION_MS,
      table: 'telemetry_span',
    };
    workers.push(
      new Promise<WriterWorkerResult>((resolve, reject) => {
        // Re-register the tsx loader in the worker so it can execute the .ts
        // entry directly (workers don't inherit the parent's --import).
        const w = new Worker(WORKER_ENTRY, { workerData, execArgv: WORKER_EXEC_ARGV });
        w.once('message', (msg: WriterWorkerResult) => resolve(msg));
        w.once('error', reject);
        w.once('exit', (code) => {
          if (code !== 0) reject(new Error(`writer ${i} exited ${code}`));
        });
      }),
    );
  }

  const results = await Promise.all(workers);
  const allLatencies: number[] = [];
  let totalCommits = 0;
  let totalErrors = 0;
  for (const r of results) {
    for (const l of r.latencies) allLatencies.push(l);
    totalCommits += r.commits;
    totalErrors += Math.max(r.errors, 0);
  }
  return {
    scenario,
    fileLayout,
    stats: summarize(allLatencies),
    totalCommits,
    totalErrors,
    observedThroughputHz: round(totalCommits / DURATION_S, 1),
  };
}

async function main(): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), 'cleo-spike-conc-'));
  try {
    process.stderr.write(
      `[T11322] writers=${WRITERS} rate=${RATE_HZ}/s duration=${DURATION_S}s ` +
        `(intervalMs=${INTERVAL_MS}) — running baseline then consolidated...\n`,
    );

    // BASELINE-EVEN: writers round-robin EVENLY across 5 SEPARATE per-domain
    // files. This is the WORST CASE for consolidation — every file absorbs only
    // ~1/5 of the writers, so the single consolidated file faces 5× the
    // per-file writer contention. Reported as the conservative upper bound.
    const baselineEven = await runScenario(
      'baseline-per-domain-even',
      `${DOMAINS.length} separate files (even round-robin)`,
      (id) => join(workdir, `even-${DOMAINS[id % DOMAINS.length]}.db`),
    );
    process.stderr.write(`[T11322] baseline-even done — p99=${round(baselineEven.stats.p99)}ms\n`);

    // BASELINE-SKEWED: models TODAY's real distribution — ~80% of writes land
    // on the hot `tasks.db`, ~20% spread across the 4 cooler domain files.
    // Consolidation's true marginal cost is "move the cool 20% into the hot
    // file", so this is the FAITHFUL migration delta (the gate metric).
    const skewSplit = Math.round(WRITERS * 0.8);
    const baselineSkewed = await runScenario(
      'baseline-skewed-hot-tasks',
      `1 hot file (~80% writers) + ${DOMAINS.length - 1} cool files (~20%)`,
      (id) =>
        id < skewSplit
          ? join(workdir, 'skew-tasks.db')
          : join(workdir, `skew-${DOMAINS[1 + (id % (DOMAINS.length - 1))]}.db`),
    );
    process.stderr.write(
      `[T11322] baseline-skewed done — p99=${round(baselineSkewed.stats.p99)}ms\n`,
    );

    // CONSOLIDATED: every writer funnels onto ONE single file (Pattern A).
    const consolidatedPath = join(workdir, 'consolidated.db');
    const consolidated = await runScenario(
      'consolidated-single-file',
      '1 single consolidated WAL file (all domains)',
      () => consolidatedPath,
    );
    process.stderr.write(`[T11322] consolidated done — p99=${round(consolidated.stats.p99)}ms\n`);

    // Gate metric = consolidated vs the FAITHFUL skewed baseline (the real
    // migration delta). The even baseline is reported as the worst-case bound.
    const ratioVsSkewed = consolidated.stats.p99 / Math.max(baselineSkewed.stats.p99, 1e-9);
    const ratioVsEven = consolidated.stats.p99 / Math.max(baselineEven.stats.p99, 1e-9);
    const withinBudget = ratioVsSkewed <= 1.5;
    const verdict = withinBudget ? 'PASS' : 'FAIL';

    const report = {
      task: 'T11322',
      config: { writers: WRITERS, rateHz: RATE_HZ, durationS: DURATION_S, intervalMs: INTERVAL_MS },
      pragmas:
        'WAL + synchronous=NORMAL + busy_timeout=30000 + wal_autocheckpoint=1000 + foreign_keys=ON',
      baselineEven,
      baselineSkewed,
      consolidated,
      gate: {
        metric: 'consolidated p99 / FAITHFUL skewed-baseline p99 (real migration delta)',
        skewedBaselineP99Ms: round(baselineSkewed.stats.p99),
        consolidatedP99Ms: round(consolidated.stats.p99),
        ratioVsSkewed: round(ratioVsSkewed, 3),
        budget: '<= 1.5',
        pass: withinBudget,
      },
      worstCaseBound: {
        note:
          'Even-split baseline is the worst case (every per-domain file absorbs ' +
          'only 1/5 of the writers, maximally favoring the multi-file layout).',
        evenBaselineP99Ms: round(baselineEven.stats.p99),
        ratioVsEven: round(ratioVsEven, 3),
        withinBudget: ratioVsEven <= 1.5,
      },
      verdict,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (verdict !== 'PASS') process.exit(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

void main();
