/**
 * Tests for the doctor orphan audit checks (T9043).
 *
 * Covers:
 * - auditOrphanWorktrees: returns passed when worktrees root doesn't exist
 * - auditOrphanWorktrees: returns passed when no orphans exist
 * - auditOrphanWorktrees: returns warning when orphan dirs are found
 * - auditOrphanTempDirs: returns passed when no orphan temp dirs
 * - auditOrphanTempDirs: returns warning when orphan temp dirs are found
 *
 * @task T9043
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditOrphanTempDirs, auditOrphanWorktrees } from '../doctor/checks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function backdateMtime(path: string, ageMs: number): void {
  const ts = new Date(Date.now() - ageMs);
  utimesSync(path, ts, ts);
}

// ---------------------------------------------------------------------------
// auditOrphanWorktrees
// ---------------------------------------------------------------------------

describe('auditOrphanWorktrees', () => {
  let tempBase: string;
  const HASH = 'testprojecthash001';

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'cleo-doc-wt-'));
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns passed when worktrees root does not exist', () => {
    const result = auditOrphanWorktrees(join(tempBase, 'nope'));
    expect(result.status).toBe('passed');
    expect(result.id).toBe('orphan_worktrees');
  });

  it('returns passed when all task dirs are active', () => {
    mkdirSync(join(tempBase, HASH, 'T1001'), { recursive: true });
    const result = auditOrphanWorktrees(tempBase, new Set(['T1001']));
    expect(result.status).toBe('passed');
  });

  it('returns warning when orphan task dirs exist', () => {
    mkdirSync(join(tempBase, HASH, 'T1001'), { recursive: true });
    mkdirSync(join(tempBase, HASH, 'T1002'), { recursive: true });

    // T1002 is not active — orphan.
    const result = auditOrphanWorktrees(tempBase, new Set(['T1001']));

    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo gc --worktrees');
    const orphans = result.details?.['orphans'] as Array<{ path: string }>;
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.path).toContain('T1002');
  });

  it('uses category worktree', () => {
    const result = auditOrphanWorktrees(tempBase);
    expect(result.category).toBe('worktree');
  });
});

// ---------------------------------------------------------------------------
// auditOrphanTempDirs
// ---------------------------------------------------------------------------

describe('auditOrphanTempDirs', () => {
  let tempBase: string;
  const MAX_AGE_MS = 1000;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'cleo-doc-tmp-'));
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns passed when no orphan CLEO temp dirs', async () => {
    const result = await auditOrphanTempDirs(tempBase, MAX_AGE_MS);
    expect(result.status).toBe('passed');
    expect(result.id).toBe('orphan_temp_dirs');
  });

  it('returns warning when orphan CLEO temp dirs exist', async () => {
    const old = mkdtempSync(join(tempBase, 'cleo-injection-chain-'));
    backdateMtime(old, MAX_AGE_MS + 5000);

    const result = await auditOrphanTempDirs(tempBase, MAX_AGE_MS);

    expect(result.status).toBe('warning');
    expect(result.fix).toBe('cleo gc --temp');
    const orphans = result.details?.['orphans'] as Array<{ path: string }>;
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans.some((o) => o.path === old)).toBe(true);
  });

  it('uses category temp', async () => {
    const result = await auditOrphanTempDirs(tempBase, MAX_AGE_MS);
    expect(result.category).toBe('temp');
  });
});
