/**
 * Integration tests for T9040 — coordination parent auto-rollup.
 *
 * A "coordination parent" is a non-epic task with no own implementation files
 * (files=null/[]) that acts as a scope container for child tasks. When all
 * children reach a terminal state (done or cancelled), the parent should
 * automatically roll up to status=done with synthesized verification evidence
 * derived from its children's gate state.
 *
 * Coverage:
 *   1. 2-child coordination parent: both done → auto-rolls-up
 *   2. 1-pending-child parent: still has 1 pending sibling → stays pending
 *   3. Parent with own files: NOT a coordination parent → rollup does NOT fire
 *   4. noAutoComplete=true: opts out → rollup does NOT fire
 *   5. All-cancelled siblings: treated as terminal → parent rolls up
 *   6. Verification evidence synthesis: gates reflect children's state
 *   7. isCoordinationParent helper unit tests
 *   8. buildRollupEvidence helper unit tests
 *
 * @task T9040
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';
import { buildRollupEvidence, isCoordinationParent } from '../coordination-parent.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('coordination parent rollup (T9040)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  const permissiveConfig = {
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
    lifecycle: { mode: 'off' },
    verification: { enabled: false },
  };

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeConfig(permissiveConfig);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Acceptance 1: parent with files=null AND all children done → auto-rolls-up
  // -------------------------------------------------------------------------

  it('auto-rolls-up a 2-child coordination parent when both children are done', async () => {
    await seedTasks(accessor, [
      {
        id: 'P001',
        title: 'Coordination Parent',
        type: 'task',
        status: 'active',
        priority: 'medium',
        // No `files` field → coordination parent
      },
      {
        id: 'C001',
        title: 'Child 1',
        type: 'task',
        status: 'done',
        priority: 'medium',
        parentId: 'P001',
        completedAt: new Date().toISOString(),
      },
      {
        id: 'C002',
        title: 'Child 2',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'P001',
      },
    ]);

    // Completing C002 should trigger parent rollup since C001 is already done
    const result = await completeTask({ taskId: 'C002' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('P001');

    const parent = await accessor.loadSingleTask('P001');
    expect(parent?.status).toBe('done');
    expect(parent?.pipelineStage).toBe('contribution');
    // Rollup verification is synthesized
    expect(parent?.verification?.passed).toBe(true);
    expect(parent?.verification?.gates?.implemented).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Acceptance 1 (negative): parent with 1 pending child → stays pending
  // -------------------------------------------------------------------------

  it('does NOT auto-roll-up when a sibling is still pending', async () => {
    await seedTasks(accessor, [
      {
        id: 'P002',
        title: 'Coordination Parent',
        type: 'task',
        status: 'active',
        priority: 'medium',
      },
      {
        id: 'C003',
        title: 'Child 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'P002',
      },
      {
        id: 'C004',
        title: 'Child 2 (still pending)',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'P002',
      },
    ]);

    const result = await completeTask({ taskId: 'C003' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted ?? []).not.toContain('P002');

    const parent = await accessor.loadSingleTask('P002');
    expect(parent?.status).not.toBe('done');
  });

  // -------------------------------------------------------------------------
  // Parent with own files: should NOT roll up as coordination parent
  // -------------------------------------------------------------------------

  it('does NOT auto-roll-up a parent that has its own files', async () => {
    await seedTasks(accessor, [
      {
        id: 'P003',
        title: 'Parent with files',
        type: 'task',
        status: 'active',
        priority: 'medium',
        files: ['src/feature.ts'], // Has own files → NOT a coordination parent
      },
      {
        id: 'C005',
        title: 'Child 1',
        type: 'task',
        status: 'done',
        priority: 'medium',
        parentId: 'P003',
        completedAt: new Date().toISOString(),
      },
      {
        id: 'C006',
        title: 'Child 2',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'P003',
      },
    ]);

    const result = await completeTask({ taskId: 'C006' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted ?? []).not.toContain('P003');

    const parent = await accessor.loadSingleTask('P003');
    expect(parent?.status).not.toBe('done');
  });

  // -------------------------------------------------------------------------
  // noAutoComplete=true: opts out of rollup
  // -------------------------------------------------------------------------

  it('does NOT auto-roll-up when parent has noAutoComplete=true', async () => {
    await seedTasks(accessor, [
      {
        id: 'P004',
        title: 'Parent with noAutoComplete',
        type: 'task',
        status: 'active',
        priority: 'medium',
        noAutoComplete: true,
      },
      {
        id: 'C007',
        title: 'Child 1',
        type: 'task',
        status: 'done',
        priority: 'medium',
        parentId: 'P004',
        completedAt: new Date().toISOString(),
      },
      {
        id: 'C008',
        title: 'Child 2',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'P004',
      },
    ]);

    const result = await completeTask({ taskId: 'C008' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted ?? []).not.toContain('P004');

    const parent = await accessor.loadSingleTask('P004');
    expect(parent?.status).not.toBe('done');
  });

  // -------------------------------------------------------------------------
  // All-cancelled siblings: treated as terminal → parent rolls up
  // -------------------------------------------------------------------------

  it('auto-rolls-up when the last active child completes and all others are cancelled', async () => {
    await seedTasks(accessor, [
      {
        id: 'P005',
        title: 'Coordination Parent',
        type: 'task',
        status: 'active',
        priority: 'medium',
      },
      {
        id: 'C009',
        title: 'Child 1 (cancelled)',
        type: 'task',
        status: 'cancelled',
        priority: 'medium',
        parentId: 'P005',
        cancelledAt: new Date().toISOString(),
      },
      {
        id: 'C010',
        title: 'Child 2 (last active)',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'P005',
      },
    ]);

    const result = await completeTask({ taskId: 'C010' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('P005');

    const parent = await accessor.loadSingleTask('P005');
    expect(parent?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for the isCoordinationParent helper
// ---------------------------------------------------------------------------

describe('isCoordinationParent helper (T9040)', () => {
  const makeTask = (overrides: Partial<Task> & { id: string }): Task =>
    ({
      id: overrides.id,
      title: 'Test Task',
      description: '',
      status: 'active',
      priority: 'medium',
      type: 'task',
      createdAt: new Date().toISOString(),
      ...overrides,
    }) as Task;

  it('returns true for a task with no files and at least 1 child', () => {
    const task = makeTask({ id: 'T001' }); // no files field
    expect(isCoordinationParent(task, 2)).toBe(true);
  });

  it('returns true for a task with an empty files array', () => {
    const task = makeTask({ id: 'T002', files: [] });
    expect(isCoordinationParent(task, 1)).toBe(true);
  });

  it('returns false when childrenCount is 0', () => {
    const task = makeTask({ id: 'T003' });
    expect(isCoordinationParent(task, 0)).toBe(false);
  });

  it('returns false when task has own files', () => {
    const task = makeTask({ id: 'T004', files: ['src/index.ts'] });
    expect(isCoordinationParent(task, 3)).toBe(false);
  });

  it('returns false when noAutoComplete=true', () => {
    const task = makeTask({ id: 'T005', noAutoComplete: true });
    expect(isCoordinationParent(task, 2)).toBe(false);
  });

  it('returns true for epic type with no files and children', () => {
    const task = makeTask({ id: 'T006', type: 'epic' });
    expect(isCoordinationParent(task, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for the buildRollupEvidence helper
// ---------------------------------------------------------------------------

describe('buildRollupEvidence helper (T9040)', () => {
  const makeChild = (
    id: string,
    status: Task['status'],
    gates?: Partial<Record<string, boolean>>,
  ): Task =>
    ({
      id,
      title: `Child ${id}`,
      description: '',
      status,
      priority: 'medium',
      type: 'task',
      createdAt: new Date().toISOString(),
      ...(gates
        ? {
            verification: {
              round: 1,
              passed: true,
              gates,
              lastAgent: null,
              lastUpdated: new Date().toISOString(),
              failureLog: [],
            },
          }
        : {}),
    }) as Task;

  it('synthesizes passed=true and implemented=true', () => {
    const children = [makeChild('C1', 'done'), makeChild('C2', 'done')];
    const ev = buildRollupEvidence('P001', children);
    expect(ev.passed).toBe(true);
    expect(ev.gates.implemented).toBe(true);
    expect(ev.round).toBe(1);
    expect(ev.failureLog).toHaveLength(0);
  });

  it('synthesizes testsPassed=true when all non-cancelled children have it', () => {
    const children = [
      makeChild('C1', 'done', { testsPassed: true }),
      makeChild('C2', 'done', { testsPassed: true }),
    ];
    const ev = buildRollupEvidence('P001', children);
    expect(ev.gates.testsPassed).toBe(true);
  });

  it('synthesizes testsPassed=false when some child failed it', () => {
    const children = [
      makeChild('C1', 'done', { testsPassed: true }),
      makeChild('C2', 'done', { testsPassed: false }),
    ];
    const ev = buildRollupEvidence('P001', children);
    expect(ev.gates.testsPassed).toBe(false);
  });

  it('ignores cancelled children when synthesizing gates', () => {
    const children = [
      makeChild('C1', 'done', { testsPassed: true }),
      makeChild('C2', 'cancelled', { testsPassed: false }), // excluded
    ];
    const ev = buildRollupEvidence('P001', children);
    expect(ev.gates.testsPassed).toBe(true);
  });

  it('treats children with no verification as passing (best-effort)', () => {
    const children = [
      makeChild('C1', 'done'), // no verification record
      makeChild('C2', 'done'), // no verification record
    ];
    const ev = buildRollupEvidence('P001', children);
    expect(ev.gates.testsPassed).toBe(true);
    expect(ev.gates.qaPassed).toBe(true);
  });

  it('includes note atoms in evidence referencing the parent ID and child IDs', () => {
    const children = [makeChild('C1', 'done'), makeChild('C2', 'done')];
    const ev = buildRollupEvidence('P001', children);
    const implEvidence = ev.evidence?.implemented;
    expect(implEvidence).toBeDefined();
    expect(implEvidence?.atoms.length).toBeGreaterThanOrEqual(1);
    const noteAtom = implEvidence?.atoms.find((a) => a.kind === 'note');
    expect(noteAtom).toBeDefined();
    if (noteAtom?.kind === 'note') {
      expect(noteAtom.note).toContain('P001');
    }
  });
});
