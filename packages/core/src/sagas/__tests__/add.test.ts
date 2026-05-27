/**
 * Regression tests for the T10118 I7 wiring inside `sagaAdd`.
 *
 * The pure-function guard `assertSagaInvariantI7` is exhaustively unit-tested
 * in `enforcement.test.ts`. This file asserts the integration boundary:
 * sagaAdd MUST call the guard with the candidate's actual type, MUST
 * convert the typed `SagaInvariantViolationError` into an EngineResult with
 * the stable `E_SAGA_INVARIANT_VIOLATION_I7` code, and MUST refuse to parent
 * a Saga under another Saga when the guard rejects.
 *
 * Includes the historical T9831-nested-in-T9799 fixture.
 *
 * @task T10118
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1.2
 */

import { createTask } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { sagaAdd } from '../add.js';
import { E_SAGA_INVARIANT_VIOLATION_I7 } from '../enforcement.js';

let TEST_ROOT: string;
let env: TestDbEnv;

/**
 * Seed two sagas (T9101 + T9102) and a regular epic (T9201) so we can assert
 * both the happy path and the nested-saga rejection path.
 */
async function seedTwoSagasFixture(testRoot: string): Promise<void> {
  const ts = '2026-05-22T00:00:00Z';
  const rows = [
    {
      id: 'T9101',
      title: 'Saga One',
      description: 'First saga',
      type: 'saga' as const,
      status: 'active' as const,
      priority: 'high' as const,
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T9102',
      title: 'Saga Two',
      description: 'Second saga — must NOT be linkable into T9101',
      type: 'saga' as const,
      status: 'active' as const,
      priority: 'high' as const,
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T9201',
      title: 'Regular Epic',
      description: 'Non-saga epic — legal saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      createdAt: ts,
      updatedAt: null,
    },
  ];

  for (const row of rows) {
    await createTask(row as Parameters<typeof createTask>[0], testRoot);
  }
}

beforeEach(async () => {
  env = await createTestDb();
  TEST_ROOT = env.tempDir;
  await seedTwoSagasFixture(TEST_ROOT);
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await env.cleanup();
});

describe('sagaAdd — ADR-073 §1.2 invariant I7 (no nested sagas)', () => {
  it('accepts a regular epic as a saga member (happy path)', async () => {
    const result = await sagaAdd(TEST_ROOT, { sagaId: 'T9101', epicId: 'T9201' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.data?.added).toBe(true);
    expect(result.data?.sagaId).toBe('T9101');
    expect(result.data?.epicId).toBe('T9201');

    const { taskShow } = await import('../../tasks/show.js');
    const member = await taskShow(TEST_ROOT, 'T9201');
    expect(member.success).toBe(true);
    expect(member.data?.task.parentId).toBe('T9101');
  });

  it('rejects a saga candidate with E_SAGA_INVARIANT_VIOLATION_I7', async () => {
    const result = await sagaAdd(TEST_ROOT, { sagaId: 'T9101', epicId: 'T9102' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(result.error?.message).toContain('T9102');
    expect(result.error?.message).toContain('saga');
    // Diag payload preserved through engineError.details.
    const diag = result.error?.details as
      | { sagaId?: string; offendingId?: string; invariant?: string }
      | undefined;
    expect(diag?.sagaId).toBe('T9101');
    expect(diag?.offendingId).toBe('T9102');
    expect(diag?.invariant).toBe('I7');
    expect(result.error?.fix ?? '').toContain('nested sagas are forbidden');
  });

  it('does NOT parent the candidate when I7 rejects it', async () => {
    const result = await sagaAdd(TEST_ROOT, { sagaId: 'T9101', epicId: 'T9102' });
    expect(result.success).toBe(false);

    const { taskShow } = await import('../../tasks/show.js');
    const candidate = await taskShow(TEST_ROOT, 'T9102');
    expect(candidate.success).toBe(true);
    expect(candidate.data?.task.parentId ?? null).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9831-nested-in-T9799 regression fixture
  // Historical: T9831 (SG-ARCH-SOLID) could theoretically have been linked
  // into T9799 (skill-maintenance saga). I7 forbids this. The reproduction
  // uses real-world IDs so the failure message matches what an operator sees.
  // ────────────────────────────────────────────────────────────────────────
  it('regression: rejects linking T9831 (saga) as a member of T9799 (saga)', async () => {
    const realEnv = await createTestDb();
    const realRoot = realEnv.tempDir;
    try {
      const ts = '2026-05-22T00:00:00Z';
      const rows = [
        {
          id: 'T9799',
          title: 'Saga T9799 (skill maintenance)',
          description: 'Top-level saga',
          type: 'saga' as const,
          status: 'active' as const,
          priority: 'high' as const,
          createdAt: ts,
          updatedAt: null,
        },
        {
          id: 'T9831',
          title: 'Saga T9831 (SG-ARCH-SOLID)',
          description: 'Top-level saga that must NOT nest under T9799',
          type: 'saga' as const,
          status: 'active' as const,
          priority: 'high' as const,
          createdAt: ts,
          updatedAt: null,
        },
      ];
      for (const row of rows) {
        await createTask(row as Parameters<typeof createTask>[0], realRoot);
      }

      const result = await sagaAdd(realRoot, { sagaId: 'T9799', epicId: 'T9831' });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
      expect(result.error?.message).toContain('T9831');
      const diag = result.error?.details as { sagaId?: string; offendingId?: string } | undefined;
      expect(diag?.sagaId).toBe('T9799');
      expect(diag?.offendingId).toBe('T9831');
    } finally {
      try {
        const { closeAllDatabases } = await import('@cleocode/core/internal');
        await closeAllDatabases();
      } catch {
        // ignore cleanup errors
      }
      await realEnv.cleanup();
    }
  });
});
