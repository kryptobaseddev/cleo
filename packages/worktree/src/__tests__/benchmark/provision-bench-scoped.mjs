#!/usr/bin/env node
/**
 * T9987 / T10053 — Provisioning benchmark with sparse-checkout scope.
 *
 * Production-realistic: agents typically target a single package (e.g.
 * `packages/cleo`) via the `spawnScope` option, which triggers
 * `git sparse-checkout init --cone` + `git sparse-checkout set <scope>`.
 * This drastically reduces checkout time on large monorepos.
 *
 * Measures the cleocode repo itself with `spawnScope: 'packages/cleo'`.
 *
 * @task T10053
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const { createWorktree, destroyWorktree } = await import('@cleocode/worktree');

const projectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function quantile(ns, q) {
  const sorted = [...ns].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

const N = Number.parseInt(process.argv[2] ?? '10', 10);
const provisionMs = [];
const destroyMs = [];
const failures = [];

console.log(`# T9987 cleocode-self benchmark WITH sparse-scope packages/cleo`);
console.log(`# project-root: ${projectRoot}`);
console.log(`# iterations: ${N}`);
console.log(``);

for (let i = 0; i < N; i++) {
  const taskId = `T9987-SCOPED-${i}`;
  const t0 = performance.now();
  let result;
  try {
    result = await createWorktree(projectRoot, {
      taskId,
      lockWorktree: false,
      applyIncludePatterns: false,
      spawnScope: 'packages/cleo',
    });
  } catch (err) {
    failures.push({ iter: i, phase: 'create', error: String(err) });
    continue;
  }
  const t1 = performance.now();
  provisionMs.push(t1 - t0);

  const t2 = performance.now();
  try {
    await destroyWorktree(projectRoot, {
      taskId,
      deleteBranch: true,
      force: true,
      reason: 'benchmark-cleanup',
    });
  } catch {}
  const t3 = performance.now();
  destroyMs.push(t3 - t2);

  if (result?.path && existsSync(result.path)) {
    try { rmSync(result.path, { recursive: true, force: true }); } catch {}
  }
  console.log(`[${i}] provision=${(t1-t0).toFixed(1)}ms destroy=${(t3-t2).toFixed(1)}ms appliedScope=${result?.appliedScope}`);
}

if (provisionMs.length === 0) {
  console.error('No successful runs.');
  process.exit(1);
}

const summary = {
  task: 'T10053',
  scenario: 'cleocode-self-scoped-packages-cleo',
  iterations: provisionMs.length,
  failures: failures.length,
  provisionMs: {
    p50: Math.round(quantile(provisionMs, 0.5) * 10) / 10,
    p90: Math.round(quantile(provisionMs, 0.9) * 10) / 10,
    p99: Math.round(quantile(provisionMs, 0.99) * 10) / 10,
    min: Math.round(Math.min(...provisionMs) * 10) / 10,
    max: Math.round(Math.max(...provisionMs) * 10) / 10,
    mean: Math.round(provisionMs.reduce((a, b) => a + b, 0) / provisionMs.length * 10) / 10,
  },
  destroyMs: { p50: Math.round(quantile(destroyMs, 0.5) * 10) / 10 },
  targetMs: 5000,
  pass: quantile(provisionMs, 0.5) < 5000,
};

console.log(``);
console.log(`# Summary (cleocode self + sparse scope packages/cleo)`);
console.log(`# p50 = ${summary.provisionMs.p50} ms`);
console.log(`# p90 = ${summary.provisionMs.p90} ms`);
console.log(`# p99 = ${summary.provisionMs.p99} ms`);
console.log(`# RESULT: ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log(``);
console.log(`JSON_SUMMARY=${JSON.stringify(summary)}`);
