/**
 * Poison tests for scripts/lint-contract-literal-enums.mjs (T11483 · DHQ-035).
 *
 * Strategy: write a synthetic mini-tree under a tmpdir that mirrors the real
 * SSoT + contract-literal layout (enums.ts, status-registry.ts, task.ts,
 * operations/tasks.ts), point the script at it with `--root <tmp>`, and assert
 * exit code + JSON report for clean vs drifted enums. This proves a bad enum is
 * caught LOCALLY without touching the real contracts tree — and, because the
 * checker reads SOURCE, that a stale `dist/` cannot hide the drift.
 *
 * @task T11483
 * @epic T11480
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-contract-literal-enums.mjs');

/** @type {string} */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-enum-lint-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Materialise the SSoT source files the validator parses for canonical members.
 */
function writeSsotFiles() {
  const contractsSrc = join(tmpRoot, 'packages/contracts/src');
  mkdirSync(join(contractsSrc, 'operations'), { recursive: true });
  writeFileSync(
    join(contractsSrc, 'enums.ts'),
    [
      "export const TASK_KINDS = ['work', 'research', 'experiment', 'bug', 'spike', 'release'] as const;",
      "export const TASK_SCOPES = ['project', 'feature', 'unit'] as const;",
      "export const TASK_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;",
      "export const TASK_SIZES = ['small', 'medium', 'large'] as const;",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(contractsSrc, 'status-registry.ts'),
    "export const TASK_STATUSES = ['pending', 'active', 'blocked', 'done', 'cancelled', 'archived', 'proposed'] as const;\n",
  );
  writeFileSync(
    join(contractsSrc, 'task.ts'),
    [
      "export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';",
      "export type TaskType = 'saga' | 'epic' | 'task' | 'subtask';",
      '',
    ].join('\n'),
  );
}

/**
 * Write the contract-literal file the validator scans for enum literals.
 *
 * @param {string} body Source body of operations/tasks.ts.
 */
function writeContractFile(body) {
  writeFileSync(join(tmpRoot, 'packages/contracts/src/operations/tasks.ts'), body);
}

/** Run the validator with `--root <tmp> --json`. */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, '--root', tmpRoot, '--json', ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

describe('lint-contract-literal-enums — clean tree', () => {
  it('passes (exit 0) when every contract-literal enum is in its SSoT', () => {
    writeSsotFiles();
    writeContractFile(
      [
        'export const SCHEMA = {',
        "  priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },",
        "  type: { type: 'string', enum: ['saga', 'epic', 'task', 'subtask'] },",
        "  kind: { type: 'string', enum: ['work', 'research', 'experiment', 'bug', 'spike', 'release'] },",
        "  severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },",
        '};',
        '',
      ].join('\n'),
    );
    const r = runLint();
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it('allows a deliberate SUBSET enum (status without archived/proposed)', () => {
    writeSsotFiles();
    // tasks.update legitimately omits archived/proposed — subset is OK.
    writeContractFile(
      "export const S = { status: { type: 'string', enum: ['pending', 'active', 'blocked', 'done', 'cancelled'] } };\n",
    );
    const r = runLint();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });
});

describe('lint-contract-literal-enums — drift detection', () => {
  it('FAILS (exit 1) on a typo enum member (criticl)', () => {
    writeSsotFiles();
    writeContractFile(
      "export const S = { priority: { type: 'string', enum: ['low', 'medium', 'high', 'criticl'] } };\n",
    );
    const r = runLint();
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({ axis: 'priority', value: 'criticl' });
  });

  it('FAILS on an out-of-range severity member (P4)', () => {
    writeSsotFiles();
    writeContractFile(
      "export const S = { severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4'] } };\n",
    );
    const r = runLint();
    expect(r.status).toBe(1);
    const v = JSON.parse(r.stdout).violations;
    expect(v.some((x) => x.axis === 'severity' && x.value === 'P4')).toBe(true);
  });

  it('FAILS on a misspelled kind member and names the canonical SSoT', () => {
    writeSsotFiles();
    writeContractFile(
      "export const S = { kind: { type: 'string', enum: ['work', 'reserch'] } };\n",
    );
    const r = runLint();
    expect(r.status).toBe(1);
    const v = JSON.parse(r.stdout).violations[0];
    expect(v).toMatchObject({ axis: 'kind', value: 'reserch', ssot: 'TASK_KINDS' });
    expect(v.canonical).toContain('research');
  });
});
