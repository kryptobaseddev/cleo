#!/usr/bin/env node
/**
 * startup-latency.mjs — CLEO CLI startup latency benchmark + regression guard.
 *
 * T9030: Measures wall-clock startup time for representative cleo commands and
 * emits a structured JSON report with p50/p95/p99 percentiles. A committed
 * baseline file (baseline.json) gates CI: if p50 regresses > 20% from the
 * baseline value, the script exits 1 (regression detected).
 *
 * Output shape (stdout, JSON):
 * {
 *   "timestamp": "2026-05-08T...",
 *   "cleo_version": "2026.5.51",
 *   "iterations": 50,
 *   "commands": {
 *     "--version": { "p50": 120, "p95": 145, "p99": 160, "samples": [...] },
 *     "--help":    { "p50": 130, "p95": 155, "p99": 170, "samples": [...] },
 *     "find foo":  { "p50": 200, "p95": 240, "p99": 260, "samples": [...] },
 *     "show T1":   { "p50": 210, "p95": 250, "p99": 270, "samples": [...] },
 *     "next":      { "p50": 220, "p95": 260, "p99": 280, "samples": [...] }
 *   },
 *   "regression": {
 *     "baseline_file": "./baseline.json",
 *     "threshold_pct": 20,
 *     "failed": false,
 *     "violations": []
 *   }
 * }
 *
 * Exit codes:
 *   0 = success (no regression vs baseline, or no baseline exists)
 *   1 = regression detected (p50 > baseline p50 * 1.20 for any command)
 *   2 = fatal setup error (cleo not found, project root not accessible)
 *
 * Usage:
 *   node scripts/bench/startup-latency.mjs
 *   CLEO_BIN=/path/to/cleo BENCH_ITERATIONS=50 node scripts/bench/startup-latency.mjs
 *   BENCH_UPDATE_BASELINE=1 node scripts/bench/startup-latency.mjs
 *
 * Environment variables:
 *   CLEO_BIN              Path to cleo binary (default: "cleo" on PATH)
 *   BENCH_ITERATIONS      Number of iterations per command (default: 50)
 *   BENCH_PROJECT_ROOT    Path to an initialized cleo project for project-scoped
 *                         commands (default: this repo's root if cleo init'd)
 *   BENCH_UPDATE_BASELINE When set to "1", writes results as new baseline.json
 *                         instead of comparing against existing baseline.
 *   BENCH_NO_REGRESSION   When set to "1", skips regression check (report only).
 *
 * @task T9030
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = join(SCRIPT_DIR, 'baseline.json');
const ITERATIONS = parseInt(process.env['BENCH_ITERATIONS'] ?? '50', 10);
const CLEO_BIN = process.env['CLEO_BIN'] ?? 'cleo';
const UPDATE_BASELINE = process.env['BENCH_UPDATE_BASELINE'] === '1';
const NO_REGRESSION = process.env['BENCH_NO_REGRESSION'] === '1';
const REGRESSION_THRESHOLD = 0.20; // 20% regression allowed

/**
 * Commands to benchmark. Each entry is:
 *   key   — display name in report
 *   args  — arguments passed to the cleo binary
 *   needsProject — whether the command needs a cleo project context
 */
const COMMANDS = [
  { key: '--version', args: ['--version'], needsProject: false },
  { key: '--help', args: ['--help'], needsProject: false },
  { key: 'find foo', args: ['find', 'foo'], needsProject: true },
  { key: 'show T1', args: ['show', 'T1'], needsProject: true },
  { key: 'next', args: ['next'], needsProject: true },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Compute percentile of a sorted number array.
 *
 * @param sorted - Array of numbers sorted ascending.
 * @param pct - Percentile between 0 and 1 (e.g. 0.5 for median).
 * @returns Interpolated percentile value in milliseconds.
 */
function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * pct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Run a single cleo command and return wall-clock elapsed time in ms.
 *
 * @param cwd - Working directory for the command.
 * @param args - Arguments to pass after the cleo binary name.
 * @returns Elapsed wall-clock time in milliseconds.
 */
function timeCleo(cwd, args) {
  const start = performance.now();
  try {
    execFileSync(CLEO_BIN, args, {
      cwd,
      stdio: 'ignore',
      timeout: 15000,
      env: {
        ...process.env,
        // Suppress pino output so it doesn't affect timing measurements.
        LOG_LEVEL: 'silent',
        CLEO_LOG_LEVEL: 'silent',
      },
    });
  } catch {
    // Non-zero exit (e.g. "show T1" when T1 doesn't exist) is expected for
    // some commands — we still want the timing.
  }
  return performance.now() - start;
}

/**
 * Resolve the best project root to use for project-scoped commands.
 *
 * Prefers BENCH_PROJECT_ROOT env, then falls back to the repo root if it has
 * a .cleo directory, then falls back to a temp project created inline.
 *
 * @returns Absolute path to a cleo-initialized project directory.
 */
function resolveProjectRoot() {
  if (process.env['BENCH_PROJECT_ROOT']) {
    return process.env['BENCH_PROJECT_ROOT'];
  }
  // Walk up from script dir to find a .cleo/ directory.
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.cleo'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: use the directory the script is run from.
  return process.cwd();
}

/**
 * Retrieve the currently installed cleo version string.
 *
 * @returns Version string like "2026.5.51", or "unknown" on failure.
 */
function getCleoVersion() {
  try {
    const raw = execFileSync(CLEO_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      env: { ...process.env, LOG_LEVEL: 'silent', CLEO_LOG_LEVEL: 'silent' },
    }).toString();
    // Output is JSON: {"success":true,"data":{"version":"2026.5.51"},...}
    const parsed = JSON.parse(raw);
    return parsed?.data?.version ?? raw.trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

/**
 * Run the benchmark and return the complete report object.
 *
 * @returns Report object matching the shape documented at the top of this file.
 */
async function runBenchmark() {
  const projectRoot = resolveProjectRoot();
  const cleoVersion = getCleoVersion();

  /** @type {Record<string, {p50: number, p95: number, p99: number, samples: number[]}>} */
  const commandResults = {};

  for (const cmd of COMMANDS) {
    const cwd = cmd.needsProject ? projectRoot : process.cwd();
    /** @type {number[]} */
    const samples = [];

    process.stderr.write(`  benchmarking: cleo ${cmd.args.join(' ')} (${ITERATIONS} iterations)...\n`);

    // Warm-up: 3 iterations not counted in samples (JIT, disk cache warm-up).
    for (let i = 0; i < 3; i++) {
      timeCleo(cwd, cmd.args);
    }

    // Measured iterations.
    for (let i = 0; i < ITERATIONS; i++) {
      samples.push(timeCleo(cwd, cmd.args));
    }

    samples.sort((a, b) => a - b);
    commandResults[cmd.key] = {
      p50: Math.round(percentile(samples, 0.5)),
      p95: Math.round(percentile(samples, 0.95)),
      p99: Math.round(percentile(samples, 0.99)),
      samples: samples.map((s) => Math.round(s)),
    };
  }

  return {
    timestamp: new Date().toISOString(),
    cleo_version: cleoVersion,
    iterations: ITERATIONS,
    commands: commandResults,
  };
}

/**
 * Compare results against a baseline and return regression info.
 *
 * @param results - Current benchmark results.
 * @param baseline - Loaded baseline.json object.
 * @returns Regression object with failed flag and violation list.
 */
function checkRegression(results, baseline) {
  /** @type {Array<{command: string, baseline_p50: number, current_p50: number, pct_change: number}>} */
  const violations = [];

  for (const key of Object.keys(results.commands)) {
    const current = results.commands[key].p50;
    const baselineCmd = baseline.commands?.[key];
    if (!baselineCmd) continue; // new command — no baseline to compare against

    const baselineP50 = baselineCmd.p50;
    const pctChange = (current - baselineP50) / baselineP50;

    if (pctChange > REGRESSION_THRESHOLD) {
      violations.push({
        command: key,
        baseline_p50: baselineP50,
        current_p50: current,
        pct_change: Math.round(pctChange * 1000) / 10, // e.g. 23.5
      });
    }
  }

  return {
    baseline_file: BASELINE_FILE,
    baseline_version: baseline.cleo_version ?? 'unknown',
    threshold_pct: Math.round(REGRESSION_THRESHOLD * 100),
    failed: violations.length > 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  // Verify cleo binary exists.
  try {
    execSync(`which ${CLEO_BIN}`, { stdio: 'ignore' });
  } catch {
    process.stderr.write(`fatal: cleo binary not found (${CLEO_BIN}). Install cleo globally or set CLEO_BIN.\n`);
    process.exit(2);
  }

  process.stderr.write(`cleo startup latency benchmark\n`);
  process.stderr.write(`  binary:     ${CLEO_BIN}\n`);
  process.stderr.write(`  iterations: ${ITERATIONS} per command (+ 3 warm-up)\n`);
  process.stderr.write(`  baseline:   ${existsSync(BASELINE_FILE) ? BASELINE_FILE : '(none — will be captured)'}\n`);
  process.stderr.write(`\n`);

  const results = await runBenchmark();

  if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_FILE, JSON.stringify(results, null, 2) + '\n');
    process.stderr.write(`\nbaseline updated: ${BASELINE_FILE}\n`);
    const report = { ...results, regression: { baseline_file: BASELINE_FILE, note: 'baseline updated — no comparison' } };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }

  let regression = { baseline_file: BASELINE_FILE, note: 'no baseline file — skipping regression check', failed: false, violations: [] };

  if (!NO_REGRESSION && existsSync(BASELINE_FILE)) {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8'));
    regression = checkRegression(results, baseline);

    if (regression.failed) {
      process.stderr.write(`\nREGRESSION DETECTED:\n`);
      for (const v of regression.violations) {
        process.stderr.write(`  cleo ${v.command}: p50 ${v.baseline_p50}ms → ${v.current_p50}ms (+${v.pct_change}%)\n`);
      }
      process.stderr.write(`\n`);
    } else {
      process.stderr.write(`\nno regression detected (all p50 within ${regression.threshold_pct}% of baseline)\n`);
    }
  }

  const report = { ...results, regression };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.exit(regression.failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
