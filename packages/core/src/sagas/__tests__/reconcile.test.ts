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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, getDb, taskShow } from '@cleocode/core/internal';
import { getCleoHome } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalProjectId } from '../../nexus/identity.js';
import { registerProjectOnEncounter } from '../../paths.js';
import { readProjectInfoAtDirectorySync, worktreeScope } from '../../project-scope.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { acquireLock } from '../../store/lock.js';
import { getNativeTasksDb } from '../../store/sqlite.js';
import { reqAdd } from '../../tasks/req.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
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
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(testRoot, '.git'), { recursive: true });
  // Create project-info.json and register in nexus.
  const { id: projectId } = await canonicalProjectId(testRoot);
  writeFileSync(
    join(cleoDir, 'project-info.json'),
    JSON.stringify({
      $schema: './schemas/project-info.schema.json',
      schemaVersion: '1.0.0',
      projectId,
      projectHash: projectId,
      cleoVersion: 'test',
      lastUpdated: new Date().toISOString(),
    }),
  );
  await registerProjectOnEncounter(testRoot, projectId);
  await getDb(testRoot);

  const ts = '2026-05-22T00:00:00Z';
  await createTask(
    {
      id: sagaId,
      title: `Saga ${sagaId}`,
      description: 'Reconcile fixture',
      type: 'saga',
      status: 'active',
      priority: 'high',
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
        parentId: sagaId,
        status: memberStatuses[i] ?? 'active',
        priority: 'medium',
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      testRoot,
    );
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
  // Explicit cwd must resolve this fixture rather than the shared setup project.
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-saga-reconcile-test-'));
  // Create project-info.json and register in nexus for all tests.
  const cleoDir = join(TEST_ROOT, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { id: projectId } = await canonicalProjectId(TEST_ROOT);
  writeFileSync(
    join(cleoDir, 'project-info.json'),
    JSON.stringify({
      $schema: './schemas/project-info.schema.json',
      schemaVersion: '1.0.0',
      projectId,
      projectHash: projectId,
      cleoVersion: 'test',
      lastUpdated: new Date().toISOString(),
    }),
  );
  await registerProjectOnEncounter(TEST_ROOT, projectId);
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
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
        type: 'saga',
        status: 'active',
        priority: 'high',
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
        parentId: 'T9002',
        status: 'active',
        priority: 'medium',
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      TEST_ROOT,
    );

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
        type: 'saga',
        status: 'active',
        priority: 'high',
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

describe('typed reconciliation authority', () => {
  async function typedSaga(): Promise<void> {
    await seedSagaWithMembers(TEST_ROOT, 'T9000', ['done']);
    writeFileSync(join(TEST_ROOT, 'proof.txt'), 'actual declared input');
    await reqAdd(TEST_ROOT, 'T9000', {
      kind: 'file',
      path: 'proof.txt',
      assertions: [{ type: 'exists' }],
      req: 'SAGA-HARD',
      description: 'Saga owns its hard requirement',
    });
  }

  function persistedSaga(): string {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], {readOnly:true}); try { process.stdout.write(JSON.stringify(db.prepare("SELECT * FROM tasks_tasks WHERE id='T9000'").all())); } finally { db.close(); }`,
        join(TEST_ROOT, '.cleo', 'cleo.db'),
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(child.status, child.stderr).toBe(0);
    return child.stdout;
  }

  it.each([
    true,
    false,
  ])('rejects unmet hard proof before predicting or writing closure (dry=%s)', async (dryRun) => {
    await typedSaga();
    const before = persistedSaga();
    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000', dryRun });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.closed).toBe(0);
    expect(result.data.errors).toBe(1);
    expect(result.data.entries[0]?.reason).toMatch(/verified result/);
    expect(persistedSaga()).toBe(before);
  });

  it('rolls back closure and preserves authentic results when the canonical receipt write fails', async () => {
    await typedSaga();
    expect(
      (
        await validateGateVerify(TEST_ROOT, {
          taskId: 'T9000',
          gate: 'cleanupDone',
          evidence: 'note:typed saga fault setup',
        })
      ).success,
    ).toBe(true);
    const accessor = await getTaskAccessor(TEST_ROOT);
    const before = persistedSaga();
    const receipts = await accessor.queryAuditLog({ taskIds: ['T9000'] });
    getNativeTasksDb(TEST_ROOT)!.exec(
      "CREATE TRIGGER reject_saga_receipt BEFORE INSERT ON tasks_audit_log WHEN NEW.action='saga_reconciled' BEGIN SELECT RAISE(ABORT,'saga receipt fault'); END",
    );
    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.closed).toBe(0);
    expect(result.data.errors).toBe(1);
    expect(persistedSaga()).toBe(before);
    expect(await accessor.queryAuditLog({ taskIds: ['T9000'] })).toEqual(receipts);
  });

  it.each([
    'cancelled',
    'expired',
  ] as const)('never renews a stopped caller lifetime: %s', async (stop) => {
    await typedSaga();
    const before = persistedSaga();
    const info = readProjectInfoAtDirectorySync(TEST_ROOT, join(TEST_ROOT, '.cleo'));
    const controller = new AbortController();
    const execution = createOperationExecutionContext(
      {
        projectId: info.projectId!,
        projectRoot: TEST_ROOT,
        actor: 'saga-test',
        operation: 'tasks.saga.reconcile',
        idempotencyKey: stop,
      },
      { deadlineAt: Date.now() + 2000, signal: controller.signal },
    );
    if (stop === 'cancelled') controller.abort(new Error('original caller cancelled'));
    else vi.spyOn(Date, 'now').mockReturnValue(execution.deadlineAt + 1);
    try {
      await expect(
        worktreeScope.run(
          { worktreeRoot: TEST_ROOT, projectHash: info.projectHash!, execution },
          () => reconcileSaga(TEST_ROOT, { sagaId: 'T9000' }),
        ),
      ).rejects.toThrow();
      expect(persistedSaga()).toBe(before);
    } finally {
      vi.restoreAllMocks();
      execution.close();
    }
  });

  it.each([
    'current',
    'stale',
    'receipt',
  ] as const)('preserves and validates actual stored typed results: %s', async (change) => {
    await typedSaga();
    expect(
      (
        await validateGateVerify(TEST_ROOT, {
          taskId: 'T9000',
          gate: 'cleanupDone',
          evidence: 'note:explicit typed saga verification',
        })
      ).success,
    ).toBe(true);
    const accessor = await getTaskAccessor(TEST_ROOT);
    const proof = (await accessor.loadSingleTask('T9000'))!.verification!.gateResults;
    expect(proof?.[0]?.result).toBe('pass');
    if (change === 'stale') writeFileSync(join(TEST_ROOT, 'proof.txt'), 'changed declared input');
    if (change === 'receipt')
      getNativeTasksDb(TEST_ROOT)!.exec(
        "DELETE FROM tasks_audit_log WHERE action='gate.verify.typed'",
      );
    const before = persistedSaga();
    const dry = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000', dryRun: true });
    expect(dry.success).toBe(true);
    if (!dry.success) return;
    expect(dry.data.closed).toBe(change === 'current' ? 1 : 0);
    expect(persistedSaga()).toBe(before);
    const actual = await reconcileSaga(TEST_ROOT, { sagaId: 'T9000' });
    expect(actual.success).toBe(true);
    if (!actual.success) return;
    expect(actual.data.closed).toBe(change === 'current' ? 1 : 0);
    if (change === 'current') {
      const after = (await accessor.loadSingleTask('T9000'))!;
      expect(after.status).toBe('done');
      expect(after.verification?.gateResults).toEqual(proof);
      expect(
        await accessor.queryAuditLog({ taskIds: ['T9000'], actions: ['saga_reconciled'] }),
      ).toHaveLength(1);
    } else expect(persistedSaga()).toBe(before);
  });
});
