/**
 * Vitest tests for ProjectTools SDK — scaffold-project, doctor-project,
 * scaffold-global (T10069 / T9835b).
 *
 * All tests operate against temporary directories so the suite is safe to
 * run in parallel and never touches the real CLEO project root.
 *
 * @task T10069
 * @epic T9835
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../../doctor/doctor-project.js';
import { scaffoldProject } from '../../scaffold/scaffold-project.js';

// ── scaffold-project ──────────────────────────────────────────────────

describe('scaffoldProject', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t10069-scaffold-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the resolved projectRoot in the result', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    expect(result.projectRoot).toBe(tmpRoot);
  });

  it('succeeds on a fresh directory', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    expect(result.success).toBe(true);
  });

  it('returns a non-empty steps array', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('reports a non-empty summary string', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('is idempotent — second call has all steps skipped or repaired', async () => {
    await scaffoldProject({ projectRoot: tmpRoot });
    const second = await scaffoldProject({ projectRoot: tmpRoot });
    expect(second.success).toBe(true);
    const created = second.steps.filter((s) => s.result?.action === 'created');
    expect(created.length).toBe(0);
  });

  it('step names include expected scaffold operations', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('cleo-structure');
    expect(names).toContain('config');
    expect(names).toContain('gitignore');
    expect(names).toContain('project-info');
  });

  it('step results have valid ScaffoldResult action values', async () => {
    const result = await scaffoldProject({ projectRoot: tmpRoot });
    const validActions = new Set(['created', 'repaired', 'skipped']);
    for (const step of result.steps) {
      if (step.result !== undefined) {
        expect(validActions.has(step.result.action)).toBe(true);
      }
    }
  });
});

// ── doctor-project ────────────────────────────────────────────────────

describe('doctorProject', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t10069-doctor-'));
    // Scaffold first so the checks have something to inspect
    await scaffoldProject({ projectRoot: tmpRoot });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the resolved projectRoot in the result', async () => {
    const result = await doctorProject({ projectRoot: tmpRoot });
    expect(result.projectRoot).toBe(tmpRoot);
  });

  it('returns a non-empty checks array', async () => {
    const result = await doctorProject({ projectRoot: tmpRoot });
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('exitCode is one of the valid values (0 | 50 | 52)', async () => {
    const result = await doctorProject({ projectRoot: tmpRoot });
    expect([0, 50, 52]).toContain(result.exitCode);
  });

  it('check entries have a string id field', async () => {
    const result = await doctorProject({ projectRoot: tmpRoot });
    for (const check of result.checks) {
      expect(typeof check.id).toBe('string');
      expect(check.id.length).toBeGreaterThan(0);
    }
  });

  it('check entries have a valid status', async () => {
    const result = await doctorProject({ projectRoot: tmpRoot });
    const validStatuses = new Set(['passed', 'failed', 'warning', 'info']);
    for (const check of result.checks) {
      expect(validStatuses.has(check.status)).toBe(true);
    }
  });

  it('exitCode 52 when at least one check failed (uninitialised project)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'cleo-t10069-noproject-'));
    try {
      const result = await doctorProject({ projectRoot: emptyDir });
      const hasFailed = result.checks.some((c) => c.status === 'failed');
      // An uninitialised dir MUST produce at least one failure.
      expect(hasFailed).toBe(true);
      expect(result.exitCode).toBe(52);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
