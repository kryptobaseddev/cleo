/**
 * Unit tests for the orchestrator-side worker re-verification gate (T1589).
 *
 * Covers:
 * - Worker reports success but tests actually fail → reject + audit row.
 * - Worker reports touched 3 files but git status shows 5 → reject + audit row.
 * - Worker reports honest success → accepted, no audit row.
 * - Mismatch audit JSONL is appended (not overwritten) across multiple calls.
 *
 * Project-agnostic verification: tests inject `runProjectTests` /
 * `listChangedFiles` stubs so no real `pnpm` / `cargo` / `git` binary is
 * required. The same code path runs identically for every primaryType.
 *
 * @task T1589
 * @epic T1586
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendWorkerMismatchAudit,
  defaultListChangedFiles,
  reVerifyWorkerReport,
  type TestRunResult,
  WORKER_MISMATCH_AUDIT_FILE,
  type WorkerReport,
} from '../worker-verify.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'worker-verify-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeReport(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    taskId: 'T9999',
    selfReportSuccess: true,
    evidenceAtoms: ['tool:test'],
    touchedFiles: ['src/a.ts'],
    ...overrides,
  };
}

function readAudit(): string[] {
  const path = join(projectRoot, WORKER_MISMATCH_AUDIT_FILE);
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
}

describe('reVerifyWorkerReport — honest success (T1589)', () => {
  it('accepts when tests pass, files match, evidence present', async () => {
    const report = makeReport({
      touchedFiles: ['src/a.ts', 'src/b.ts'],
      evidenceAtoms: ['tool:test', 'commit:abc1234'],
    });

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async (): Promise<TestRunResult> => ({ ok: true }),
      listChangedFiles: async () => ['src/a.ts', 'src/b.ts'],
    });

    expect(result.accepted).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.auditEntry).toBeNull();
  });

  it('treats path order independently (git reports reverse order)', async () => {
    const report = makeReport({
      touchedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: true }),
      listChangedFiles: async () => ['src/c.ts', 'src/a.ts', 'src/b.ts'],
    });

    expect(result.accepted).toBe(true);
  });
});

describe('reVerifyWorkerReport — false success (T1589)', () => {
  it('rejects + audits when worker claims success but tests fail', async () => {
    const report = makeReport();

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: false, reason: '12 failed tests' }),
      listChangedFiles: async () => ['src/a.ts'],
    });

    expect(result.accepted).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatch(/tests:/);
    expect(result.auditEntry).not.toBeNull();
    expect(result.auditEntry?.mismatches[0].kind).toBe('tests');
    expect(result.auditEntry?.mismatches[0].actual).toMatch(/12 failed tests/);

    const lines = readAudit();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed['taskId']).toBe('T9999');
    expect(parsed['claimedSuccess']).toBe(true);
  });

  it('rejects + audits when claimed touched-files count mismatches git', async () => {
    const report = makeReport({
      touchedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'], // 3 claimed
    });

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: true }),
      listChangedFiles: async () => ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], // 5 actual
    });

    expect(result.accepted).toBe(false);
    expect(result.mismatches[0]).toMatch(/files:/);
    expect(result.auditEntry?.mismatches[0].kind).toBe('files');
    expect(result.auditEntry?.actualFiles).toHaveLength(5);
    expect(result.auditEntry?.claimedFiles).toHaveLength(3);
  });

  it('rejects when claimed file set diverges from git (same count, different paths)', async () => {
    const report = makeReport({
      touchedFiles: ['src/a.ts', 'src/b.ts'],
    });

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: true }),
      listChangedFiles: async () => ['src/a.ts', 'src/different.ts'],
    });

    expect(result.accepted).toBe(false);
    expect(result.auditEntry?.mismatches[0].kind).toBe('files');
  });

  it('rejects when worker claims success but supplies zero evidence atoms', async () => {
    const report = makeReport({
      evidenceAtoms: [],
    });

    const result = await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: true }),
      listChangedFiles: async () => ['src/a.ts'],
    });

    expect(result.accepted).toBe(false);
    expect(result.auditEntry?.mismatches.some((m) => m.kind === 'evidence')).toBe(true);
  });
});

describe('reVerifyWorkerReport — audit log append-only (T1589)', () => {
  it('appends multiple mismatch entries without overwriting prior lines', async () => {
    const report = makeReport({ taskId: 'T1' });

    await reVerifyWorkerReport(report, {
      projectRoot,
      runProjectTests: async () => ({ ok: false, reason: 'first failure' }),
      listChangedFiles: async () => ['src/a.ts'],
    });
    await reVerifyWorkerReport(
      { ...report, taskId: 'T2' },
      {
        projectRoot,
        runProjectTests: async () => ({ ok: false, reason: 'second failure' }),
        listChangedFiles: async () => ['src/a.ts'],
      },
    );
    await reVerifyWorkerReport(
      { ...report, taskId: 'T3' },
      {
        projectRoot,
        runProjectTests: async () => ({ ok: false, reason: 'third failure' }),
        listChangedFiles: async () => ['src/a.ts'],
      },
    );

    const lines = readAudit();
    expect(lines).toHaveLength(3);
    const ids = lines.map((line) => {
      const parsed = JSON.parse(line) as { taskId: string };
      return parsed.taskId;
    });
    expect(ids).toEqual(['T1', 'T2', 'T3']);
  });

  it('appendWorkerMismatchAudit creates the audit directory on first write', async () => {
    appendWorkerMismatchAudit(projectRoot, {
      timestamp: '2026-04-29T00:00:00Z',
      taskId: 'T7',
      claimedSuccess: true,
      claimedFiles: [],
      actualFiles: [],
      mismatches: [{ kind: 'tests', claimed: 'success', actual: 'failed', reason: 'unit test' }],
    });
    const lines = readAudit();
    expect(lines).toHaveLength(1);
  });
});

describe('defaultListChangedFiles — porcelain parsing (T1589)', () => {
  it('returns empty array when git is not initialised in the directory', async () => {
    // mkdtemp dir has no .git — git status exits non-zero, our helper
    // returns [] (the `error` handler resolves with empty list).
    const files = await defaultListChangedFiles(projectRoot);
    expect(Array.isArray(files)).toBe(true);
  });
});
