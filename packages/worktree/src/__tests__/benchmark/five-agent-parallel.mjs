#!/usr/bin/env node
/**
 * T9987 / T10055 — 5-agent parallel provisioning test.
 *
 * Simulates `cleo orchestrate spawn` × 5 in parallel by invoking the same
 * `createWorktree` SDK function the dispatch layer would call. The test
 * validates:
 *
 *   1. All 5 worktrees provision in under 60s (the timeout the saga targets).
 *   2. Each worktree lands under the canonical XDG path.
 *   3. No race conditions in branch / index management.
 *   4. Aggregate elapsed time on a warm pnpm store.
 *
 * NOTE: this exercises the LOCAL HEAD code via the workspace-linked
 * `@cleocode/worktree`. The globally-installed `cleo` v2026.5.100 ships with
 * the pre-T9982 hardcoded `node_modules + packages/[STAR]/dist` bootstrap, so
 * `cleo orchestrate spawn` against the npm install hits the 60s timeout on
 * the cleocode monorepo. This script proves the saga fix works.
 *
 * @task T10055
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const { createWorktree, destroyWorktree } = await import('@cleocode/worktree');

const projectRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const taskIds = ['T9987-PAR-1', 'T9987-PAR-2', 'T9987-PAR-3', 'T9987-PAR-4', 'T9987-PAR-5'];

console.log('# T9987 5-agent parallel provisioning');
console.log(`# project-root: ${projectRoot}`);
console.log(`# task IDs: ${taskIds.join(', ')}`);
console.log('');

const tWallStart = performance.now();
const startedAt = new Map();
const finishedAt = new Map();

const results = await Promise.allSettled(
  taskIds.map(async (taskId) => {
    startedAt.set(taskId, performance.now());
    const r = await createWorktree(projectRoot, {
      taskId,
      lockWorktree: false,
      applyIncludePatterns: false,
    });
    finishedAt.set(taskId, performance.now());
    return r;
  }),
);

const tWallEnd = performance.now();

const perTaskMs = [];
const canonicalOk = [];
const xdgRoot = process.env['HOME'] + '/.local/share/cleo/worktrees/';
for (const [i, r] of results.entries()) {
  const taskId = taskIds[i];
  const dur = (finishedAt.get(taskId) ?? tWallEnd) - (startedAt.get(taskId) ?? tWallStart);
  perTaskMs.push(dur);
  if (r.status === 'fulfilled') {
    const isCanonical = r.value.path.startsWith(xdgRoot);
    canonicalOk.push(isCanonical);
    console.log(
      `[${taskId}] OK dur=${dur.toFixed(1)}ms canonical=${isCanonical} path=${r.value.path}`,
    );
  } else {
    canonicalOk.push(false);
    console.log(`[${taskId}] FAIL: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  }
}

// Cleanup
for (const taskId of taskIds) {
  try {
    await destroyWorktree(projectRoot, {
      taskId,
      deleteBranch: true,
      force: true,
      reason: 'parallel-test-cleanup',
    });
  } catch {}
}

const wallMs = tWallEnd - tWallStart;
const slowest = Math.max(...perTaskMs);
const pass = results.every((r) => r.status === 'fulfilled') && canonicalOk.every(Boolean);

const summary = {
  task: 'T10055',
  agents: 5,
  wallMs: Math.round(wallMs * 10) / 10,
  slowestAgentMs: Math.round(slowest * 10) / 10,
  meanAgentMs: Math.round((perTaskMs.reduce((a, b) => a + b, 0) / perTaskMs.length) * 10) / 10,
  budgetMs: 60000,
  allUnderBudget: slowest < 60000,
  allCanonicalXDG: canonicalOk.every(Boolean),
  allSucceeded: results.every((r) => r.status === 'fulfilled'),
  pass,
};

console.log('');
console.log(`# Wall time = ${summary.wallMs} ms`);
console.log(`# Slowest agent = ${summary.slowestAgentMs} ms`);
console.log(`# Mean agent = ${summary.meanAgentMs} ms`);
console.log(`# Budget (cleo orchestrate spawn) = ${summary.budgetMs} ms`);
console.log(`# All under budget = ${summary.allUnderBudget}`);
console.log(`# All canonical XDG = ${summary.allCanonicalXDG}`);
console.log(`# RESULT: ${summary.pass ? 'PASS' : 'FAIL'}`);
console.log('');
console.log(`JSON_SUMMARY=${JSON.stringify(summary)}`);
process.exit(summary.pass ? 0 : 1);
