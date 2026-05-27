/**
 * Tests for {@link reconcileSaga} — the T10121 idempotent cron-safe saga
 * auto-close repair verb.
 *
 * Covered acceptance criteria:
 *
 *   - **AC1** — `reconcileSaga(projectRoot)` walks every saga and flips
 *     `status='done'` on any saga whose members are all terminal.
 *   - **AC2** — `reconcileSaga(projectRoot, { sagaId })` reconciles a
 *     single saga.
 *   - **AC3** — Idempotency: a second invocation against an already-correct
 *     saga emits `action: 'no-op'` and does NOT mutate the row.
 *   - **AC4** — Per-saga advisory lock serializes concurrent runs.
 *   - **AC5** — Every decision is recorded as a JSON-line entry under
 *     `.cleo/audit/saga-reconcile.jsonl` with timestamp + sagaId + action
 *     + members + reason.
 *
 * @task T10121
 * @saga T10113
 * @epic T10210
 * @see ADR-073-above-epic-naming.md §1.3
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRelation, createTask, getDb, taskShow } from '@cleocode/core/internal';
import { getCleoHome } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../store/lock.js';
import { reconcileSaga, SAGA_RECONCILE_AUDIT_FILE } from '../reconcile.js';

let TEST_ROOT: string;

/**
 * Seed one saga (`T9000`) with `n` member epics. Each member is given the
 * status supplied in `memberStatuses` (default: all `'active'`). Saga itself
 * is seeded `'active'`.
 */
async function seedSagaWithMembers(
  testRoot: string,
  sagaId: string,
  memberStatuses: Array<'active' | 'done' | 'cancelled' | 'archived' | 'pending'>,
): Promise<string[]> {
  mkdirSync(join(testRoot, '.cleo'), { recursive: true });
  mkdirSync(join(testRoot, '.git'), { recursive: true });
  await getDb(testRoot);

  const ts = '2026-05-22T00:00:00Z';
  await createTask(
    {
      id: sagaId,
      title: `Saga ${sagaId}`,
      description: 'Reconcile fixture',
      type: 'epic',
      status: 'active',
      priority: 'high',
      labels: ['saga'],
      createdAt: ts,
      updatedAt: null,
    } as Parameters<typeof createTask>[0],
    testRoot,
  );

  const memberIds: string[] = [];
  for (let i = 0; i < memberStatuses.length; i++) {
    const memberId = `T901${i + 1}`;
    memberIds.push(memberId);
    await createTask(
      {
        id: memberId,
        title: `Epic ${memberId}`,
        description: `Member ${i + 1}`,
        type: 'epic',
        status: memberStatuses[i] ?? 'active',
        priority: 'medium',
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      testRoot,
    );
    await addRelation(sagaId, memberId, 'groups', testRoot);
  }
  return memberIds;
}

interface SagaReconcileAuditLine {
  timestamp: string;
  sagaId: string;
  action: 'close' | 'no-op' | 'blocked' | 'error';
  membersAffected: string[];
  pendingMembers: string[];
  reason: string;
  statusBefore: string;
  statusAfter: string;
  dryRun: boolean;
}

/** Read every JSON line currently present in the saga-reconcile audit log. */
function readAuditLines(testRoot: string): SagaReconcileAuditLine[] {
  const file = join(testRoot, SAGA_RECONCILE_AUDIT_FILE);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SagaReconcileAuditLine);
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-saga-reconcile-test-'));
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('reconcileSaga — closure path (AC1, AC2, AC5)', () => {
  it('closes a single saga when all members are terminal (AC2)', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'done']);

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;

    expect(result.data.total).toBe(1);
    expect(result.data.closed).toBe(1);
    expect(result.data.noOp).toBe(0);
    expect(result.data.entries[0]?.action).toBe('close');
    expect(result.data.entries[0]?.sagaId).toBe('T9000');
    expect(result.data.entries[0]?.statusBefore).toBe('active');
    expect(result.data.entries[0]?.statusAfter).toBe('done');

    // Verify the row was actually written
    const after = await taskShow(TEST_ROOT, 'T9000');
    expect(after.data?.task.status).toBe('done');
    expect(after.data?.task.completedAt).toBeTruthy();
  });

  it('treats `cancelled` and `archived` members as terminal for closure', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'cancelled', 'archived']);

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.closed).toBe(1);
    expect(result.data.entries[0]?.action).toBe('close');
  });

  it('walks every saga when no sagaId supplied (AC1)', async () => {
    // Two sagas — one closure-ready, one with a pending member.
    await seedSagaWithMembers(TEST_ROOT, 'T9001', ['done', 'done']);

    // Inline second-saga seed (re-using the helper would clobber .git/.cleo).
    const ts = '2026-05-22T00:00:00Z';
    await createTask(
      {
        id: 'T9002',
        title: 'Saga 2',
        type: 'epic',
        status: 'active',
        priority: 'high',
        labels: ['saga'],
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      TEST_ROOT,
    );
    await createTask(
      {
        id: 'T9013',
        title: 'Pending Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      TEST_ROOT,
    );
    await addRelation('T9002', 'T9013', 'groups', TEST_ROOT);

    const result = await reconcileSaga(TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.total).toBe(2);
    expect(result.data.closed).toBe(1);
    expect(result.data.pending).toBe(1);
    const closedIds = result.data.entries.filter((e) => e.action === 'close').map((e) => e.sagaId);
    expect(closedIds).toContain('T9001');
  });

  it('appends one JSON-line entry per reconcile decision (AC5)', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'done']);
    await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });

    const lines = readAuditLines(TEST_ROOT);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry?.sagaId).toBe('T9000');
    expect(entry?.action).toBe('close');
    expect(entry?.membersAffected.sort()).toEqual(['T9011', 'T9012']);
    expect(entry?.pendingMembers).toEqual([]);
    expect(entry?.statusBefore).toBe('active');
    expect(entry?.statusAfter).toBe('done');
    expect(entry?.dryRun).toBe(false);
    expect(typeof entry?.timestamp).toBe('string');
    expect(typeof entry?.reason).toBe('string');
  });
});

describe('reconcileSaga — idempotency (AC3)', () => {
  it('emits action=no-op on a saga that is already done', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'done']);
    const first = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(first.success).toBe(true);
    if (first.success) expect(first.data.entries[0]?.action).toBe('close');

    const second = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.entries[0]?.action).toBe('no-op');
    expect(second.data.noOp).toBe(1);
    expect(second.data.closed).toBe(0);
  });

  it('emits action=no-op when members are pending (no closure)', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'active']);
    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries[0]?.action).toBe('no-op');
    expect(result.data.entries[0]?.pendingMembers).toContain('T9012');
    expect(result.data.pending).toBe(1);
    expect(result.data.closed).toBe(0);

    // Saga row must still be active.
    const after = await taskShow(TEST_ROOT, 'T9000');
    expect(after.data?.task.status).toBe('active');
  });
});

describe('reconcileSaga — dry-run mode', () => {
  it('reports closure intent without mutating the row or writing audit log', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'done']);

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000', dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.dryRun).toBe(true);
    expect(result.data.entries[0]?.action).toBe('close');
    // statusAfter mirrors statusBefore in dry-run mode.
    expect(result.data.entries[0]?.statusAfter).toBe('active');

    // Row must NOT have flipped.
    const after = await taskShow(TEST_ROOT, 'T9000');
    expect(after.data?.task.status).toBe('active');

    // Audit log must not exist (dry-run skips the write).
    const lines = readAuditLines(TEST_ROOT);
    expect(lines).toHaveLength(0);
  });
});

describe('reconcileSaga — concurrency (AC4)', () => {
  it('returns action=blocked when the per-saga lock is held by another caller', async () => {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done', 'done']);

    // Manually acquire the per-saga lock (mirrors what a concurrent
    // invocation would do) BEFORE invoking reconcileSaga. The lock-file
    // path is the same one the reconciler uses.
    const lockDir = join(getCleoHome(), 'locks', 'saga-reconcile');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'T9000.lock');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(lockPath, '', { encoding: 'utf-8' });
    const release = await acquireLock(lockPath, { retries: 0, stale: 300_000 });

    try {
      const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.entries[0]?.action).toBe('blocked');
      expect(result.data.blocked).toBe(1);

      // Saga row must still be active — closure did not run.
      const after = await taskShow(TEST_ROOT, 'T9000');
      expect(after.data?.task.status).toBe('active');

      // The blocked decision must still be audit-logged.
      const lines = readAuditLines(TEST_ROOT);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.action).toBe('blocked');
    } finally {
      await release();
    }
  });
});

describe('reconcileSaga — zero-member sagas', () => {
  it('records a no-op entry for a saga with no members', async () => {
    // Saga only — no member relations.
    mkdirSync(join(TEST_ROOT, '.cleo'), { recursive: true });
    mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
    await getDb(TEST_ROOT);
    const ts = '2026-05-22T00:00:00Z';
    await createTask(
      {
        id: 'T9000',
        title: 'Empty saga',
        type: 'epic',
        status: 'active',
        priority: 'high',
        labels: ['saga'],
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      TEST_ROOT,
    );

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries[0]?.action).toBe('no-op');
    expect(result.data.entries[0]?.reason).toContain('zero members');
  });
});

describe('reconcileSaga — error paths', () => {
  it('records action=error when the supplied saga does not exist', async () => {
    mkdirSync(join(TEST_ROOT, '.cleo'), { recursive: true });
    mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
    await getDb(TEST_ROOT);

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T999999' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries[0]?.action).toBe('error');
    expect(result.data.errors).toBe(1);
  });
});
