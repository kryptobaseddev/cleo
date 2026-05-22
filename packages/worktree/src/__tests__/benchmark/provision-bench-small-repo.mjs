#!/usr/bin/env node
/**
 * T9987 / T10053 — Provisioning benchmark on a small repo.
 *
 * Same shape as provision-bench.mjs but against a synthetic small repo
 * (~10 files, 1 commit) so we measure the SDK overhead, not the underlying
 * `git worktree add` checkout time which is bounded by file count.
 *
 * Saga AC: p50 < 5000ms on warm pnpm store.
 *
 * @task T10053
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const { createWorktree, destroyWorktree } = await import('@cleocode/worktree');

function initSmallRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-bench-repo-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'bench@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Bench'], { cwd: dir, stdio: 'pipe' });
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `content ${i}\n`);
  }
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function quantile(ns, q) {
  const sorted = [...ns].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

const N = Number.parseInt(process.argv[2] ?? '10', 10);
const projectRoot = initSmallRepo();
const provisionMs = [];
const destroyMs = [];
const failures = [];

// Set a temp CLEO_HOME so we don't pollute the user's real worktree root
const cleoHome = mkdtempSync(join(tmpdir(), 'cleo-bench-home-'));
process.env['CLEO_HOME'] = cleoHome;

console.log(`# T9987 small-repo provisioning benchmark`);
console.log(`# project-root: ${projectRoot} (synthetic 10-file repo)`);
console.log(`# cleo-home: ${cleoHome}`);
console.log(`# iterations: ${N}`);
console.log(``);

for (let i = 0; i < N; i++) {
  const taskId = `T9987-SMALL-${i}`;
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
  console.log(`[${i}] provision=${(t1-t0).toFixed(1)}ms destroy=${(t3-t2).toFixed(1)}ms`);
}

// Cleanup project root + cleo home
try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
try { rmSync(cleoHome, { recursive: true, force: true }); } catch {}

if (provisionMs.length === 0) {
  console.error('No successful runs.');
  process.exit(1);
}

const summary = {
  task: 'T10053',
  scenario: 'small-repo',
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
  preSagaBaselineMs: '~30000-60000',
};

console.log(``);
console.log(`# Summary (small repo, ~10 files)`);
console.log(`# p50 = ${summary.provisionMs.p50} ms`);
console.log(`# p90 = ${summary.provisionMs.p90} ms`);
console.log(`# p99 = ${summary.provisionMs.p99} ms`);
console.log(`# RESULT: ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log(``);
console.log(`JSON_SUMMARY=${JSON.stringify(summary)}`);
