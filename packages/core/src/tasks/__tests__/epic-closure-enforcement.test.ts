/**
 * Integration tests for epic closure enforcement (T1404 / P1-4).
 *
 * Verifies that `cleo complete <epicId>` rejects if the epic has:
 * - No direct evidence atoms on any verification gate, AND
 * - No children where all non-cancelled children have status=done + verification.passed=true.
 *
 * Acceptance criteria:
 * - Epic with direct evidence atoms → completes
 * - Epic with all children verified-done → completes
 * - Epic with no children + no direct evidence → REJECTED (E_EVIDENCE_MISSING)
 * - Epic with unverified children + no direct evidence → REJECTED (E_EVIDENCE_MISSING)
 * - Advisory/off lifecycle mode → gate is bypassed (behavior preserved)
 *
 * @task T1404
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask, verifyEpicHasEvidence } from '../complete.js';

// ---- config helpers --------------------------------------------------------

/** Strict lifecycle + verification enabled: new gate fires. */
function strictConfig(): string {
  return JSON.stringify({
    lifecycle: { mode: 'strict' },
    verification: { enabled: true },
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
  });
}

/** Advisory mode: gate should be bypassed. */
function advisoryConfig(): string {
  return JSON.stringify({
    lifecycle: { mode: 'advisory' },
    verification: { enabled: true },
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
  });
}

/** Verification disabled: gate should be bypassed. */
function verificationOffConfig(): string {
  return JSON.stringify({
    lifecycle: { mode: 'strict' },
    verification: { enabled: false },
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
  });
}

// ---- shared task builders --------------------------------------------------

const now = new Date().toISOString();

/** Build a minimal epic task with an optional verification record. */
function makeEpic(
  id: string,
  opts?: {
    verification?: import('@cleocode/contracts').Task['verification'];
  },
) {
  return {
    id,
    title: `Epic ${id}`,
    description: 'Epic description',
    type: 'epic' as const,
    status: 'active' as const,
    priority: 'medium' as const,
    acceptance: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'],
    createdAt: now,
    updatedAt: now,
    ...(opts?.verification ? { verification: opts.verification } : {}),
  };
}

/** Build a minimal child task. */
function makeChild(
  id: string,
  parentId: string,
  opts?: {
    status?: 'pending' | 'active' | 'done' | 'cancelled';
    verification?: import('@cleocode/contracts').Task['verification'];
  },
) {
  const status = opts?.status ?? 'done';
  return {
    id,
    title: `Child ${id}`,
    description: 'Child task',
    type: 'task' as const,
    status,
    priority: 'medium' as const,
    parentId,
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: now } : {}),
    ...(opts?.verification ? { verification: opts.verification } : {}),
  };
}

/** A GateEvidence record with one note atom. */
function makeGateEvidence(): import('@cleocode/contracts').GateEvidence {
  return {
    atoms: [{ kind: 'note', note: 'direct evidence for gate' }],
    capturedAt: now,
    capturedBy: 'test',
  };
}

/** A TaskVerification record with all gates passed and evidence atoms. */
function makePassedVerification(): import('@cleocode/contracts').TaskVerification {
  return {
    passed: true,
    round: 1,
    gates: {
      implemented: true,
      testsPassed: true,
      qaPassed: true,
      securityPassed: true,
      documented: true,
    },
    evidence: {
      implemented: makeGateEvidence(),
    },
    lastAgent: 'coder',
    lastUpdated: now,
    failureLog: [],
  };
}

/** A TaskVerification record with gates passed but NO evidence atoms. */
function makeVerificationNoEvidence(): import('@cleocode/contracts').TaskVerification {
  return {
    passed: true,
    round: 1,
    gates: {
      implemented: true,
      testsPassed: true,
      qaPassed: true,
      securityPassed: true,
      documented: true,
    },
    lastAgent: 'coder',
    lastUpdated: now,
    failureLog: [],
  };
}

// ===========================================================================
// Unit tests for verifyEpicHasEvidence
// ===========================================================================

describe('verifyEpicHasEvidence (unit)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('returns true when epic has direct evidence atoms', async () => {
    const epic = {
      ...makeEpic('T001', { verification: makePassedVerification() }),
    } as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(true);
  });

  it('returns false when epic has no evidence and no children', async () => {
    const epic = {
      ...makeEpic('T001'),
    } as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(false);
  });

  it('returns false when epic verification record exists but has no atoms', async () => {
    const epic = {
      ...makeEpic('T001', { verification: makeVerificationNoEvidence() }),
    } as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(false);
  });

  it('returns true when all non-cancelled children are done+verified', async () => {
    const epic = makeEpic('T001') as import('@cleocode/contracts').Task;
    const child1 = makeChild('T002', 'T001', {
      status: 'done',
      verification: makePassedVerification(),
    }) as import('@cleocode/contracts').Task;
    const child2 = makeChild('T003', 'T001', {
      status: 'done',
      verification: makePassedVerification(),
    }) as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);
    await accessor.upsertSingleTask(child1);
    await accessor.upsertSingleTask(child2);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(true);
  });

  it('returns true when all non-cancelled children are done+verified (cancelled sibling ignored)', async () => {
    const epic = makeEpic('T001') as import('@cleocode/contracts').Task;
    const child1 = makeChild('T002', 'T001', {
      status: 'done',
      verification: makePassedVerification(),
    }) as import('@cleocode/contracts').Task;
    const child2 = makeChild('T003', 'T001', {
      status: 'cancelled',
    }) as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);
    await accessor.upsertSingleTask(child1);
    await accessor.upsertSingleTask(child2);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(true);
  });

  it('returns false when child is done but verification.passed is false', async () => {
    const epic = makeEpic('T001') as import('@cleocode/contracts').Task;
    const child1 = makeChild('T002', 'T001', {
      status: 'done',
      verification: {
        passed: false,
        round: 1,
        gates: {},
        lastAgent: null,
        lastUpdated: now,
        failureLog: [],
      },
    }) as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);
    await accessor.upsertSingleTask(child1);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(false);
  });

  it('returns false when child is pending (not done)', async () => {
    const epic = makeEpic('T001') as import('@cleocode/contracts').Task;
    const child1 = makeChild('T002', 'T001', {
      status: 'pending',
    }) as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);
    await accessor.upsertSingleTask(child1);

    const result = await verifyEpicHasEvidence(epic, accessor);
    expect(result).toBe(false);
  });

  it('returns false when only cancelled children exist (no non-cancelled)', async () => {
    // All-cancelled means nonCancelled.length === 0, so condition 2 fails
    const epic = makeEpic('T001') as import('@cleocode/contracts').Task;
    const child1 = makeChild('T003', 'T001', {
      status: 'cancelled',
    }) as import('@cleocode/contracts').Task;
    await accessor.upsertSingleTask(epic);
    await accessor.upsertSingleTask(child1);

    const result = await verifyEpicHasEvidence(epic, accessor);
    // No direct evidence + no non-cancelled children → false
    expect(result).toBe(false);
  });
});

// ===========================================================================
// Integration tests via completeTask
// ===========================================================================

describe('epic closure enforcement (strict mode, integration)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(join(env.cleoDir, 'config.json'), strictConfig());
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('REJECTS: epic with no children and no direct evidence', async () => {
    await seedTasks(accessor, [makeEpic('T001')]);

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toMatchObject({
      code: ExitCode.LIFECYCLE_GATE_FAILED,
      message: expect.stringContaining('cannot complete without direct evidence'),
    });
  });

  it('REJECTS: epic with unverified children and no direct evidence', async () => {
    await seedTasks(accessor, [
      makeEpic('T001'),
      makeChild('T002', 'T001', {
        status: 'done',
        verification: {
          passed: false,
          round: 1,
          gates: {},
          lastAgent: null,
          lastUpdated: now,
          failureLog: [],
        },
      }),
    ]);

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toMatchObject({
      code: ExitCode.LIFECYCLE_GATE_FAILED,
      message: expect.stringContaining('cannot complete without direct evidence'),
    });
  });

  it('REJECTS: epic with mix of verified + pending children and no direct evidence', async () => {
    await seedTasks(accessor, [
      makeEpic('T001'),
      makeChild('T002', 'T001', {
        status: 'done',
        verification: makePassedVerification(),
      }),
      makeChild('T003', 'T001', { status: 'pending' }),
    ]);

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toMatchObject({
      code: ExitCode.LIFECYCLE_GATE_FAILED,
      message: expect.stringContaining('cannot complete without direct evidence'),
    });
  });

  it('ALLOWS: epic with direct evidence atoms on at least one gate', async () => {
    await seedTasks(accessor, [makeEpic('T001', { verification: makePassedVerification() })]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('ALLOWS: epic where all non-cancelled children are done+verified', async () => {
    await seedTasks(accessor, [
      makeEpic('T001'),
      makeChild('T002', 'T001', {
        status: 'done',
        verification: makePassedVerification(),
      }),
      makeChild('T003', 'T001', {
        status: 'done',
        verification: makePassedVerification(),
      }),
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('ALLOWS: epic where remaining non-cancelled child is done+verified (cancelled sibling ignored)', async () => {
    await seedTasks(accessor, [
      makeEpic('T001'),
      makeChild('T002', 'T001', {
        status: 'done',
        verification: makePassedVerification(),
      }),
      makeChild('T003', 'T001', { status: 'cancelled' }),
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });
});

describe('epic closure enforcement (advisory mode — gate bypassed)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(join(env.cleoDir, 'config.json'), advisoryConfig());
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('allows epic completion with no evidence and no children (advisory mode)', async () => {
    await seedTasks(accessor, [makeEpic('T001')]);

    // Should NOT reject — advisory mode skips the evidence gate
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });
});

describe('epic closure enforcement (verification disabled — gate bypassed)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(join(env.cleoDir, 'config.json'), verificationOffConfig());
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('allows epic completion with no evidence when verification is disabled', async () => {
    await seedTasks(accessor, [makeEpic('T001')]);

    // Should NOT reject — verification disabled skips the evidence gate
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });
});
