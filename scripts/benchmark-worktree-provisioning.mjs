#!/usr/bin/env node
/**
 * Benchmark: worktree provisioning performance (T9807)
 *
 * Measures wall-clock provisioning time and disk-usage delta for three
 * strategies across N=5 runs each:
 *
 *   1. baseline    — `git worktree add` only (no CoW copy, no sparse-checkout)
 *   2. cow         — `git worktree add` + copy-on-write CoW for node_modules
 *   3. sparse      — `git worktree add` + sparse-checkout cone mode
 *
 * Results are written to `.cleo/research/t9807-provisioning-benchmark.json`.
 *
 * Usage:
 *   node scripts/benchmark-worktree-provisioning.mjs [--runs N] [--scope <dir>]
 *
 * @task T9807
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const RUNS = runsIdx >= 0 ? parseInt(args[runsIdx + 1], 10) : 5;
const scopeIdx = args.indexOf('--scope');
const SCOPE = scopeIdx >= 0 ? args[scopeIdx + 1] : 'packages/cleo';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Measure disk usage of a path in bytes (du -sb, Linux only). */
function diskBytes(p) {
  if (!existsSync(p)) return 0;
  try {
    const out = execFileSync('du', ['-sb', p], { encoding: 'utf-8' });
    return parseInt(out.split('\t')[0], 10);
  } catch {
    return -1;
  }
}

/** Create a temporary worktree path under /tmp. */
function tmpWorktreePath(label) {
  return join(tmpdir(), `cleo-bench-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

/** Cleanup a worktree (unlock + remove). Best-effort. */
function cleanupWorktree(path) {
  try {
    execFileSync('git', ['worktree', 'unlock', path], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }
  try {
    execFileSync('git', ['worktree', 'remove', '--force', path], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }
  rmSync(path, { recursive: true, force: true });
}

/** Delete a temporary branch. Best-effort. */
function cleanupBranch(branch) {
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    });
  } catch {
    // ignore
  }
}

/** Time a callback in milliseconds. */
async function timeMs(fn) {
  const start = performance.now();
  await fn();
  return Math.round(performance.now() - start);
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

async function runBaseline(i) {
  const branch = `bench/baseline-${i}-${Date.now()}`;
  const path = tmpWorktreePath(`baseline-${i}`);
  try {
    const ms = await timeMs(() => {
      execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
      });
    });
    const bytes = diskBytes(path);
    return { ms, bytes };
  } finally {
    cleanupWorktree(path);
    cleanupBranch(branch);
  }
}

async function runCoW(i) {
  const branch = `bench/cow-${i}-${Date.now()}`;
  const path = tmpWorktreePath(`cow-${i}`);
  try {
    const ms = await timeMs(async () => {
      execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
      });
      // Copy node_modules via CoW (--reflink=auto on Linux, -cR on macOS)
      const platform = process.platform;
      const nmSrc = join(PROJECT_ROOT, 'node_modules');
      const nmDst = join(path, 'node_modules');
      if (existsSync(nmSrc)) {
        if (platform === 'darwin') {
          try {
            execFileSync('cp', ['-cR', nmSrc, nmDst], { stdio: 'ignore', timeout: 60_000 });
          } catch {
            execFileSync('cp', ['-R', nmSrc, nmDst], { stdio: 'ignore', timeout: 60_000 });
          }
        } else {
          try {
            execFileSync('cp', ['-R', '--reflink=auto', nmSrc, nmDst], {
              stdio: 'ignore',
              timeout: 60_000,
            });
          } catch {
            execFileSync('cp', ['-R', nmSrc, nmDst], { stdio: 'ignore', timeout: 60_000 });
          }
        }
      }
    });
    const bytes = diskBytes(path);
    return { ms, bytes };
  } finally {
    cleanupWorktree(path);
    cleanupBranch(branch);
  }
}

async function runSparse(i) {
  const branch = `bench/sparse-${i}-${Date.now()}`;
  const path = tmpWorktreePath(`sparse-${i}`);
  try {
    const ms = await timeMs(() => {
      execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
      });
      try {
        execFileSync('git', ['sparse-checkout', 'init', '--cone'], {
          cwd: path,
          stdio: 'ignore',
        });
        execFileSync('git', ['sparse-checkout', 'set', SCOPE], {
          cwd: path,
          stdio: 'ignore',
        });
      } catch {
        // sparse-checkout may not be available — continue without it
      }
    });
    const bytes = diskBytes(path);
    return { ms, bytes };
  } finally {
    cleanupWorktree(path);
    cleanupBranch(branch);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return { p50, p95, mean };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.error(`[bench] T9807 worktree provisioning benchmark — ${RUNS} runs each`);
console.error(`[bench] scope for sparse strategy: ${SCOPE}`);
console.error('[bench] strategies: baseline, cow, sparse');

const results = { baseline: [], cow: [], sparse: [] };

for (let i = 0; i < RUNS; i++) {
  process.stderr.write(`[bench] run ${i + 1}/${RUNS}...`);

  const b = await runBaseline(i);
  results.baseline.push(b);
  process.stderr.write(' baseline');

  const c = await runCoW(i);
  results.cow.push(c);
  process.stderr.write(' cow');

  const s = await runSparse(i);
  results.sparse.push(s);
  process.stderr.write(' sparse\n');
}

const summary = {};
for (const [strategy, runs] of Object.entries(results)) {
  const msValues = runs.map((r) => r.ms);
  const bytesValues = runs.map((r) => r.bytes).filter((b) => b >= 0);
  summary[strategy] = {
    provisioning_ms: stats(msValues),
    disk_bytes: bytesValues.length > 0 ? stats(bytesValues) : null,
    runs: runs.length,
  };
}

const output = {
  task: 'T9807',
  description: 'Worktree provisioning benchmark: baseline vs CoW vs sparse-checkout',
  generated_at: new Date().toISOString(),
  config: { runs: RUNS, scope: SCOPE, platform: process.platform, node: process.version },
  summary,
  note: {
    baseline: 'git worktree add only — no extra steps',
    cow: 'git worktree add + copy-on-write copy of node_modules (--reflink=auto on Linux, -cR on macOS)',
    sparse: `git worktree add + sparse-checkout cone mode limited to '${SCOPE}'`,
    disk_bytes:
      'du -sb of the worktree directory; -1 means du failed; CoW bytes may appear larger than baseline because the copy is counted separately by du even when reflinks share blocks',
  },
};

const outDir = join(PROJECT_ROOT, '.cleo', 'research');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 't9807-provisioning-benchmark.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.error(`[bench] results written to ${outPath}`);

// Print a quick human summary
console.log('\n=== T9807 Provisioning Benchmark Summary ===');
for (const [strategy, data] of Object.entries(summary)) {
  const ms = data.provisioning_ms;
  const gb = data.disk_bytes ? `disk p50=${(data.disk_bytes.p50 / 1e6).toFixed(0)}MB` : 'disk=n/a';
  console.log(`  ${strategy.padEnd(10)} ms p50=${ms.p50} p95=${ms.p95} mean=${ms.mean}  ${gb}`);
}
console.log('');
