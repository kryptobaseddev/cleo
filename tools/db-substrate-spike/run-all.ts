/**
 * T11244 spike — run every gate harness and emit a consolidated PASS/FAIL roll-up.
 *
 * Executes each harness as a child `tsx` process, captures its JSON verdict,
 * and prints a single roll-up object plus the architectural-lock verdict. Used
 * both for local one-shot verification and as the CI gate entrypoint.
 *
 * The concurrency harness defaults to the full 5-minute gate; set
 * `SPIKE_DURATION_S` low for a fast local run. The durability harness defaults
 * to 100 SIGKILL iterations; set `SPIKE_KILL_ITERS` low for a fast local run.
 *
 * Run (fast):  SPIKE_DURATION_S=15 SPIKE_KILL_ITERS=20 pnpm dlx tsx tools/db-substrate-spike/run-all.ts
 * Run (gate):  pnpm dlx tsx tools/db-substrate-spike/run-all.ts
 *
 * @task T11244
 * @saga T11242
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX_BIN = createRequire(import.meta.url).resolve('tsx/cli');

/** One harness to run, keyed by its child task. */
interface Harness {
  task: string;
  file: string;
}

const HARNESSES: Harness[] = [
  { task: 'T11321', file: '01-substrate-floor.ts' },
  { task: 'T11322', file: '02-concurrency-bench.ts' },
  { task: 'T11323', file: '03-idempotency-bench.ts' },
  { task: 'T11324', file: '04-consolidation-fixture.ts' },
  { task: 'T11325', file: '05-durability.ts' },
  { task: 'T11326', file: '06-napi-internalization.ts' },
];

/** Run one harness and parse its trailing JSON verdict. */
function runHarness(h: Harness): { task: string; verdict: string; exitCode: number } {
  const res = spawnSync(process.execPath, [TSX_BIN, join(HERE, h.file)], {
    encoding: 'utf8',
    timeout: 900_000,
    env: process.env,
  });
  let verdict = 'UNKNOWN';
  try {
    const parsed = JSON.parse(res.stdout) as { verdict?: string };
    verdict = parsed.verdict ?? 'UNKNOWN';
  } catch {
    verdict = 'PARSE_ERROR';
  }
  process.stderr.write(`[run-all] ${h.task} (${h.file}) → ${verdict} (exit ${res.status})\n`);
  return { task: h.task, verdict, exitCode: res.status ?? -1 };
}

function main(): void {
  const results = HARNESSES.map(runHarness);
  const allPass = results.every((r) => r.verdict === 'PASS' && r.exitCode === 0);
  const report = {
    spike: 'T11244 — SQLite 3.53.0 consolidation architectural lock',
    results,
    architecturalLock: allPass ? 'HOLDS' : 'DOES-NOT-HOLD',
    verdict: allPass ? 'PASS' : 'FAIL',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!allPass) process.exit(1);
}

main();
