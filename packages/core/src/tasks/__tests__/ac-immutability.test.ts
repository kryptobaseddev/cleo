/**
 * Tests for the acceptance-criteria immutability guard (T1590).
 *
 * Covers the four contract requirements from T-FOUNDATION-LOCKDOWN Wave A:
 *  1. Updating AC at stage `research` succeeds (no lock).
 *  2. Updating AC at stage `implementation` without `--reason` is rejected
 *     with {@link ExitCode.AC_LOCKED}.
 *  3. Updating AC at stage `implementation` with a non-empty `--reason`
 *     succeeds and an entry is appended to `.cleo/audit/ac-changes.jsonl`.
 *  4. The audit JSONL file is append-only — multiple overrides accumulate
 *     without truncation.
 *
 * @epic T1586 Foundation Lockdown (Wave A)
 * @task T1590
 */

import { existsSync, readFileSync, writeFile } from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  AC_CHANGES_AUDIT_FILE,
  AC_LOCKED_STAGES,
  acceptanceEquals,
  isAcceptanceLocked,
} from '../ac-immutability.js';
import { updateTask } from '../update.js';

// Suppress unused warnings on the helpers we re-import for sanity checks.
void writeFile;
void writeFileAsync;

// ===========================================================================
// Pure-function unit tests
// ===========================================================================

describe('isAcceptanceLocked', () => {
  it('returns false for null/undefined stages', () => {
    expect(isAcceptanceLocked(null)).toBe(false);
    expect(isAcceptanceLocked(undefined)).toBe(false);
    expect(isAcceptanceLocked('')).toBe(false);
  });

  it('returns false for pre-implementation stages', () => {
    expect(isAcceptanceLocked('research')).toBe(false);
    expect(isAcceptanceLocked('consensus')).toBe(false);
    expect(isAcceptanceLocked('architecture_decision')).toBe(false);
    expect(isAcceptanceLocked('specification')).toBe(false);
    expect(isAcceptanceLocked('decomposition')).toBe(false);
  });

  it('returns true for implementation and later stages', () => {
    expect(isAcceptanceLocked('implementation')).toBe(true);
    expect(isAcceptanceLocked('validation')).toBe(true);
    expect(isAcceptanceLocked('testing')).toBe(true);
    expect(isAcceptanceLocked('release')).toBe(true);
    expect(isAcceptanceLocked('contribution')).toBe(true);
  });

  it('locked-stage set has exactly five entries', () => {
    expect(AC_LOCKED_STAGES.size).toBe(5);
  });
});

describe('acceptanceEquals', () => {
  it('treats null/undefined/empty as equivalent', () => {
    expect(acceptanceEquals(undefined, undefined)).toBe(true);
    expect(acceptanceEquals(null, undefined)).toBe(true);
    expect(acceptanceEquals([], undefined)).toBe(true);
    expect(acceptanceEquals([], null)).toBe(true);
  });

  it('returns true for identical string arrays', () => {
    expect(acceptanceEquals(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  it('returns false on length mismatch', () => {
    expect(acceptanceEquals(['a'], ['a', 'b'])).toBe(false);
  });

  it('returns false on element mismatch', () => {
    expect(acceptanceEquals(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

// ===========================================================================
// Integration tests against updateTask (real SQLite + audit log)
// ===========================================================================

describe('updateTask + AC-immutability guard (T1590)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    // Seed a task we can mutate. Stage is set per-test via direct upsert.
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Foundation lockdown subject',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        acceptance: ['original AC 1', 'original AC 2'],
        pipelineStage: 'research',
      },
    ]);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_AGENT_ID'];
    resetDbState();
    await env.cleanup();
  });

  // ---------------------------------------------------------------------
  // 1. Pre-implementation stage → AC mutation succeeds without --reason.
  // ---------------------------------------------------------------------
  it('allows acceptance update at stage research without --reason', async () => {
    const result = await updateTask(
      { taskId: 'T001', acceptance: ['new AC 1', 'new AC 2', 'new AC 3'] },
      env.tempDir,
      accessor,
    );
    expect(result.changes).toContain('acceptance');
    expect(result.task.acceptance).toEqual(['new AC 1', 'new AC 2', 'new AC 3']);

    // No audit entry should be written for unlocked-stage updates.
    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 2. Implementation stage without --reason → rejected with E_AC_LOCKED.
  // ---------------------------------------------------------------------
  it('rejects acceptance update at stage implementation without --reason', async () => {
    // Advance task into implementation stage.
    const seed = await accessor.loadSingleTask('T001');
    if (!seed) throw new Error('seed task missing');
    seed.pipelineStage = 'implementation';
    await accessor.upsertSingleTask(seed);

    await expect(
      updateTask(
        { taskId: 'T001', acceptance: ['reframed AC 1', 'reframed AC 2'] },
        env.tempDir,
        accessor,
      ),
    ).rejects.toMatchObject({
      code: ExitCode.AC_LOCKED,
      message: expect.stringContaining('Acceptance criteria locked at stage implementation'),
    });

    // Task AC must remain unchanged.
    const after = await accessor.loadSingleTask('T001');
    expect(after?.acceptance).toEqual(['original AC 1', 'original AC 2']);

    // No audit entry should be written for rejected attempts.
    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 3. Implementation stage with --reason → succeeds + audit entry.
  // ---------------------------------------------------------------------
  it('allows acceptance update at stage implementation with --reason and writes audit entry', async () => {
    process.env['CLEO_AGENT_ID'] = 'foundation-worker-3';

    const seed = await accessor.loadSingleTask('T001');
    if (!seed) throw new Error('seed task missing');
    seed.pipelineStage = 'implementation';
    await accessor.upsertSingleTask(seed);

    const result = await updateTask(
      {
        taskId: 'T001',
        acceptance: ['expanded AC 1', 'expanded AC 2', 'expanded AC 3'],
        reason: 'operator approved scope expansion',
      },
      env.tempDir,
      accessor,
    );
    expect(result.changes).toContain('acceptance');
    expect(result.task.acceptance).toEqual(['expanded AC 1', 'expanded AC 2', 'expanded AC 3']);

    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({
      taskId: 'T001',
      stage: 'implementation',
      reason: 'operator approved scope expansion',
      oldAcceptance: ['original AC 1', 'original AC 2'],
      newAcceptance: ['expanded AC 1', 'expanded AC 2', 'expanded AC 3'],
      agent: 'foundation-worker-3',
    });
    expect(typeof entry['timestamp']).toBe('string');
  });

  // ---------------------------------------------------------------------
  // 4. Audit JSONL is append-only across multiple overrides.
  // ---------------------------------------------------------------------
  it('appends rather than overwrites the audit log on repeated overrides', async () => {
    const seed = await accessor.loadSingleTask('T001');
    if (!seed) throw new Error('seed task missing');
    seed.pipelineStage = 'implementation';
    await accessor.upsertSingleTask(seed);

    await updateTask(
      {
        taskId: 'T001',
        acceptance: ['after first override A', 'after first override B'],
        reason: 'first override',
      },
      env.tempDir,
      accessor,
    );

    await updateTask(
      {
        taskId: 'T001',
        acceptance: ['after second override A', 'after second override B'],
        reason: 'second override',
      },
      env.tempDir,
      accessor,
    );

    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { reason: string; oldAcceptance: string[] };
    const second = JSON.parse(lines[1]!) as { reason: string; oldAcceptance: string[] };
    expect(first.reason).toBe('first override');
    expect(first.oldAcceptance).toEqual(['original AC 1', 'original AC 2']);
    expect(second.reason).toBe('second override');
    // The second override's "before" snapshot reflects the AC written by the first.
    expect(second.oldAcceptance).toEqual(['after first override A', 'after first override B']);
  });

  // ---------------------------------------------------------------------
  // 5. Idempotent payload at locked stage → no error, no audit write.
  // ---------------------------------------------------------------------
  it('treats a structurally-identical AC payload at a locked stage as a no-op', async () => {
    const seed = await accessor.loadSingleTask('T001');
    if (!seed) throw new Error('seed task missing');
    seed.pipelineStage = 'implementation';
    await accessor.upsertSingleTask(seed);

    // Provide the exact same AC array — guard must NOT throw because nothing changes.
    const result = await updateTask(
      {
        taskId: 'T001',
        acceptance: ['original AC 1', 'original AC 2'],
        // Also supply a title change so the update has a non-empty changeset.
        title: 'Title-only edit at locked stage',
      },
      env.tempDir,
      accessor,
    );
    expect(result.changes).toContain('title');
    // The audit log must NOT be created for a no-op AC payload.
    const auditPath = join(env.tempDir, AC_CHANGES_AUDIT_FILE);
    expect(existsSync(auditPath)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // 6. Empty/whitespace --reason at a locked stage is treated as missing.
  // ---------------------------------------------------------------------
  it('rejects an empty --reason as if it were missing', async () => {
    const seed = await accessor.loadSingleTask('T001');
    if (!seed) throw new Error('seed task missing');
    seed.pipelineStage = 'validation';
    await accessor.upsertSingleTask(seed);

    await expect(
      updateTask(
        {
          taskId: 'T001',
          acceptance: ['changed AC 1', 'changed AC 2'],
          reason: '   ',
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toMatchObject({ code: ExitCode.AC_LOCKED });
  });
});
