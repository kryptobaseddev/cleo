/**
 * Tests for the session drift-watchdog (file-scope drift).
 *
 * @task T1594
 * @epic T1586
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccessor } from '../../store/data-accessor.js';
import {
  DEFAULT_PIVOT_THRESHOLD,
  DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC,
  DRIFT_WATCHDOG_INTERVAL_ENV,
  detectSessionDrift,
  getDriftWatchdogIntervalSec,
  resolveDriftAuditPath,
} from '../drift-watchdog.js';
import { startSession } from '../index.js';

describe('drift-watchdog', () => {
  let tempDir: string;
  let cleoDir: string;
  let auditPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-drift-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    auditPath = join(tempDir, 'audit-out.jsonl');
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // -------------------------------------------------------------------------
  // No active task → empty report (no drift possible)
  // -------------------------------------------------------------------------

  it('returns an empty report when there is no active session or task', async () => {
    const report = await detectSessionDrift({
      projectRoot: tempDir,
      auditPathOverride: auditPath,
      listChangedFiles: async () => ['src/foo.ts', 'src/bar.ts'],
    });

    expect(report.activeTaskId).toBeNull();
    expect(report.declaredFiles).toEqual([]);
    expect(report.outsideScope).toEqual([]);
    expect(report.insideScope).toEqual([]);
    expect(report.suggestedPivot).toBeUndefined();
    // Modified files are still surfaced for visibility, but no drift recorded.
    expect(report.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);

    // Audit log MUST NOT be written when there is no active task.
    await expect(stat(auditPath)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Active task whose declared files match all modified files → no drift
  // -------------------------------------------------------------------------

  it('reports no drift when modified files all match declared scope', async () => {
    const accessor = await getAccessor(tempDir);
    const task: Task = {
      id: 'T9001',
      title: 'In-scope only',
      description: 'Drift test fixture — declared exactly matches modified.',
      status: 'in_progress',
      priority: 'medium',
      files: ['src/a.ts', 'src/b.ts'],
    };
    await accessor.upsertSingleTask(task);

    await startSession(tempDir, {
      name: 'drift-test-clean',
      scope: 'global',
      startTask: 'T9001',
    });

    const report = await detectSessionDrift({
      projectRoot: tempDir,
      auditPathOverride: auditPath,
      listChangedFiles: async () => ['src/a.ts', 'src/b.ts'],
    });

    expect(report.activeTaskId).toBe('T9001');
    expect(report.declaredFiles.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(report.insideScope.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(report.outsideScope).toEqual([]);
    expect(report.suggestedPivot).toBeUndefined();

    await expect(stat(auditPath)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Active task with files outside declared scope → drift, audit, pivot
  // -------------------------------------------------------------------------

  it('detects drift, appends audit entry, and suggests a pivot', async () => {
    const accessor = await getAccessor(tempDir);
    const task: Task = {
      id: 'T9002',
      title: 'Narrow scope',
      description: 'Drift test fixture — declared scope is intentionally narrow.',
      status: 'in_progress',
      priority: 'medium',
      files: ['src/audit.ts'],
    };
    await accessor.upsertSingleTask(task);

    await startSession(tempDir, {
      name: 'drift-test-sidetrack',
      scope: 'global',
      startTask: 'T9002',
    });

    const report = await detectSessionDrift({
      projectRoot: tempDir,
      auditPathOverride: auditPath,
      listChangedFiles: async () => ['src/audit.ts', 'src/layering.ts', 'src/engine-planning.ts'],
    });

    expect(report.activeTaskId).toBe('T9002');
    expect(report.insideScope).toEqual(['src/audit.ts']);
    expect(report.outsideScope.sort()).toEqual(['src/engine-planning.ts', 'src/layering.ts']);
    // 2/3 = 0.66… > 0.5 → pivot suggested.
    expect(report.suggestedPivot).toMatch(/^cleo pivot T9002 <newTask>/);

    // Audit log MUST be written and well-formed JSONL.
    const raw = await readFile(auditPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.activeTaskId).toBe('T9002');
    expect(entry.outsideScope.sort()).toEqual(['src/engine-planning.ts', 'src/layering.ts']);
    expect(entry.pivotSuggested).toBe(true);
    expect(typeof entry.timestamp).toBe('string');
    expect(typeof entry.ratio).toBe('number');
  });

  // -------------------------------------------------------------------------
  // Drift below threshold → reported but no pivot suggestion
  // -------------------------------------------------------------------------

  it('records drift without suggesting a pivot below the threshold', async () => {
    const accessor = await getAccessor(tempDir);
    const task: Task = {
      id: 'T9003',
      title: 'Mostly in-scope',
      description: 'Drift test fixture — only one file outside declared scope.',
      status: 'in_progress',
      priority: 'medium',
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    };
    await accessor.upsertSingleTask(task);

    await startSession(tempDir, {
      name: 'drift-test-minor',
      scope: 'global',
      startTask: 'T9003',
    });

    const report = await detectSessionDrift({
      projectRoot: tempDir,
      auditPathOverride: auditPath,
      // 1 of 4 outside scope → 0.25 ≤ 0.5 (default threshold)
      listChangedFiles: async () => ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/extra.ts'],
    });

    expect(report.outsideScope).toEqual(['src/extra.ts']);
    expect(report.suggestedPivot).toBeUndefined();

    // Audit still appended — drift > 0 is auditable even when below pivot
    // threshold, so the system has a record of every sidetrack event.
    const raw = await readFile(auditPath, 'utf-8');
    const entry = JSON.parse(raw.trim().split('\n')[0]!);
    expect(entry.pivotSuggested).toBe(false);
    expect(entry.outsideScope).toEqual(['src/extra.ts']);
  });

  // -------------------------------------------------------------------------
  // Project-agnostic: default reader uses git, works in any git project.
  // -------------------------------------------------------------------------

  it('uses git status --porcelain by default (project-agnostic)', async () => {
    // Create a fresh git repo inside the temp dir to verify the default reader
    // returns paths from real `git status` output. This is the contract:
    // the watchdog must work in ANY git project.
    const { spawn } = await import('node:child_process');
    const run = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: tempDir, stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`)),
        );
      });

    await run('git', ['init', '-q']);
    await run('git', ['config', 'user.email', 'test@example.com']);
    await run('git', ['config', 'user.name', 'Drift Test']);

    // Create a modified file in the working tree.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tempDir, 'README.md'), '# drift fixture\n', 'utf-8');

    // No active task → still exercises the default reader path and proves
    // the watchdog runs cleanly in any git project.
    const report = await detectSessionDrift({
      projectRoot: tempDir,
      auditPathOverride: auditPath,
      // Note: NO listChangedFiles override — we want the default to fire.
    });

    expect(report.modifiedFiles).toContain('README.md');
  });

  // -------------------------------------------------------------------------
  // Cadence env-var plumbing
  // -------------------------------------------------------------------------

  it('reads the watchdog interval from the environment with sane fallbacks', () => {
    expect(getDriftWatchdogIntervalSec({})).toBe(DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC);
    expect(getDriftWatchdogIntervalSec({ [DRIFT_WATCHDOG_INTERVAL_ENV]: '60' })).toBe(60);
    // Invalid values fall back to the default rather than NaN/0/negative.
    expect(getDriftWatchdogIntervalSec({ [DRIFT_WATCHDOG_INTERVAL_ENV]: '0' })).toBe(
      DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC,
    );
    expect(getDriftWatchdogIntervalSec({ [DRIFT_WATCHDOG_INTERVAL_ENV]: 'not-a-number' })).toBe(
      DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC,
    );
  });

  // -------------------------------------------------------------------------
  // Audit-path resolution honours scope.
  // -------------------------------------------------------------------------

  it('resolves the local audit path under .cleo/audit', () => {
    const local = resolveDriftAuditPath('/tmp/proj', 'local');
    expect(local).toBe('/tmp/proj/.cleo/audit/session-drift.jsonl');
  });

  it('resolves the global audit path under ~/.local/share/cleo/audit', () => {
    const global = resolveDriftAuditPath('/tmp/proj', 'global');
    expect(global).toMatch(/audit\/session-drift\.jsonl$/);
    expect(global).toMatch(/\.local\/share\/cleo/);
  });

  // -------------------------------------------------------------------------
  // Sanity: exposed default threshold matches public contract.
  // -------------------------------------------------------------------------

  it('exposes the documented default pivot threshold', () => {
    expect(DEFAULT_PIVOT_THRESHOLD).toBe(0.5);
  });
});
