#!/usr/bin/env node
/**
 * T9987 / T10053 — Provisioning benchmark.
 *
 * Measures `createWorktree` end-to-end provisioning latency over N=10
 * iterations. Reports p50/p90/p99 in ms.
 *
 * Saga AC: p50 < 5000ms on warm pnpm store.
 * Pre-saga baseline: ~30–60s per worktree (cleo orchestrate spawn 60s timeout).
 *
 * Usage:
 *   node packages/worktree/src/__tests__/benchmark/provision-bench.mjs [N]
 *
 * The script provisions ephemeral worktrees against the current git repo
 * (the cleocode worktree itself) under `~/.local/share/cleo/worktrees/<hash>/`
 * with synthetic task IDs `T9987-BENCH-<n>`. Each worktree is destroyed
 * after timing.
 *
 * Output is human-readable plus a JSON summary at the end (one line) so
 * downstream tooling can ingest the numbers.
 *
 * @task T10053
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const projectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

// Import compiled SDK so we exercise the same code paths as cleo orchestrate spawn.
const { createWorktree, destroyWorktree } = await import('@cleocode/worktree');

/**
 * @param {number[]} ns
 * @param {number} q quantile in (0,1)
 */
function quantile(ns, q) {
  const sorted = [...ns].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

const N = Number.parseInt(process.argv[2] ?? '10', 10);
const provisionMs = [];
const destroyMs = [];
const failures = [];

console.log(`# T9987 provisioning benchmark`);
console.log(`# project-root: ${projectRoot}`);
console.log(`# iterations: ${N}`);
console.log(``);

for (let i = 0; i < N; i++) {
  const taskId = `T9987-BENCH-${i}`;
  const t0 = performance.now();
  let result;
  try {
    result = await createWorktree(projectRoot, {
      taskId,
      lockWorktree: false,
      applyIncludePatterns: false,
    });
  } catch (err) {
    failures.push({ iter: i, phase: 'create', error: String(err) });
    console.log(`[${i}] FAIL create: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  const t1 = performance.now();
  const pms = t1 - t0;
  provisionMs.push(pms);

  // Destroy
  const t2 = performance.now();
  try {
    await destroyWorktree(projectRoot, {
      taskId,
      deleteBranch: true,
      force: true,
      reason: 'benchmark-cleanup',
    });
  } catch (err) {
    failures.push({ iter: i, phase: 'destroy', error: String(err) });
  }
  const t3 = performance.now();
  destroyMs.push(t3 - t2);

  // Belt-and-suspenders cleanup
  if (result?.path && existsSync(result.path)) {
    try {
      rmSync(result.path, { recursive: true, force: true });
    } catch {}
  }

  console.log(`[${i}] provision=${pms.toFixed(1)}ms destroy=${(t3 - t2).toFixed(1)}ms`);
}

if (provisionMs.length === 0) {
  console.error('No successful runs — aborting summary.');
  process.exit(1);
}

const p50 = quantile(provisionMs, 0.5);
const p90 = quantile(provisionMs, 0.9);
const p99 = quantile(provisionMs, 0.99);
const min = Math.min(...provisionMs);
const max = Math.max(...provisionMs);
const mean = provisionMs.reduce((a, b) => a + b, 0) / provisionMs.length;

const dp50 = quantile(destroyMs, 0.5);

const summary = {
  task: 'T10053',
  iterations: provisionMs.length,
  failures: failures.length,
  provisionMs: {
    p50: Math.round(p50 * 10) / 10,
    p90: Math.round(p90 * 10) / 10,
    p99: Math.round(p99 * 10) / 10,
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    mean: Math.round(mean * 10) / 10,
  },
  destroyMs: {
    p50: Math.round(dp50 * 10) / 10,
  },
  targetMs: 5000,
  pass: p50 < 5000,
  preSagaBaselineMs: '~30000-60000',
};

console.log(``);
console.log(`# Summary`);
console.log(`# p50 = ${summary.provisionMs.p50} ms`);
console.log(`# p90 = ${summary.provisionMs.p90} ms`);
console.log(`# p99 = ${summary.provisionMs.p99} ms`);
console.log(`# min = ${summary.provisionMs.min} ms`);
console.log(`# max = ${summary.provisionMs.max} ms`);
console.log(`# mean = ${summary.provisionMs.mean} ms`);
console.log(`# destroy-p50 = ${summary.destroyMs.p50} ms`);
console.log(`# target = ${summary.targetMs} ms (saga AC: p50 < 5000ms)`);
console.log(`# pre-saga baseline = ${summary.preSagaBaselineMs} ms`);
console.log(`# RESULT: ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log(``);
console.log(`JSON_SUMMARY=${JSON.stringify(summary)}`);
