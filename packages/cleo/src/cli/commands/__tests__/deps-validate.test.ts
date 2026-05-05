/**
 * Tests for T1857: cleo deps validate + cleo deps tree commands.
 *
 * Covers dep-graph validation functions directly (no CLI layer mocking needed
 * since the logic lives in the pure-function core layer):
 *
 *  1. Orphan detection — non-epic task with no parentId → E_ORPHAN
 *  2. Circular dep detection — A → B → A → E_CIRCULAR
 *  3. Cross-epic gap detection — cross-epic dep without epic-level dep → E_CROSS_EPIC_GAP
 *  4. Stale dep to cancelled task → E_STALE_DEP
 *  5. Clean graph → { valid: true, issues: [] }
 *  6. --epic scoping — validateDepGraph scoped to epic children only
 *
 * Tests call the pure-function core helpers directly so no SQLite / dispatch
 * infrastructure is required.
 *
 * @task T1857
 * @epic T1855
 */

import type { Task } from '@cleocode/contracts';
import {
  detectCrossEpicGaps,
  detectOrphans,
  detectStaleDeps,
  nearestEpic,
  runValidation,
  validateDepGraph,
} from '@cleocode/core';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Task object with sensible defaults. */
function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: `Description for ${overrides.title}`,
    status: 'pending',
    priority: 'medium',
    type: 'task',
    createdAt: new Date().toISOString(),
    depends: [],
    ...overrides,
  } as Task;
}

function makeEpic(overrides: Partial<Task> & { id: string; title: string }): Task {
  return makeTask({ type: 'epic', ...overrides });
}

// ---------------------------------------------------------------------------
// 1. Orphan detection
// ---------------------------------------------------------------------------

describe('detectOrphans', () => {
  it('flags a non-epic task with no parentId as E_ORPHAN', () => {
    const tasks: Task[] = [makeTask({ id: 'T001', title: 'Orphan task', parentId: undefined })];
    const issues = detectOrphans(tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('E_ORPHAN');
    expect(issues[0]!.taskId).toBe('T001');
  });

  it('does NOT flag epics without parentId', () => {
    const tasks: Task[] = [makeEpic({ id: 'E001', title: 'Top-level epic', parentId: undefined })];
    const issues = detectOrphans(tasks);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag tasks in terminal state (done/cancelled/archived)', () => {
    const tasks: Task[] = [
      makeTask({ id: 'T001', title: 'Done orphan', parentId: undefined, status: 'done' }),
      makeTask({ id: 'T002', title: 'Cancelled orphan', parentId: undefined, status: 'cancelled' }),
      makeTask({ id: 'T003', title: 'Archived orphan', parentId: undefined, status: 'archived' }),
    ];
    const issues = detectOrphans(tasks);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag tasks that have a parentId', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Parent epic' }),
      makeTask({ id: 'T001', title: 'Child task', parentId: 'E001' }),
    ];
    const issues = detectOrphans(tasks);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Circular dep detection (via validateDepGraph)
// ---------------------------------------------------------------------------

describe('validateDepGraph — circular deps', () => {
  it('detects A → B → A cycle and returns E_CIRCULAR issue', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Task A', parentId: 'E001', depends: ['T002'] }),
      makeTask({ id: 'T002', title: 'Task B', parentId: 'E001', depends: ['T001'] }),
    ];
    const result = validateDepGraph(tasks);
    expect(result.valid).toBe(false);
    const cyclicIssues = result.issues.filter((i) => i.code === 'E_CIRCULAR');
    expect(cyclicIssues.length).toBeGreaterThan(0);
    expect(cyclicIssues[0]!.relatedIds).toBeDefined();
  });

  it('does NOT flag a clean linear chain as circular', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Task A', parentId: 'E001' }),
      makeTask({ id: 'T002', title: 'Task B', parentId: 'E001', depends: ['T001'] }),
    ];
    const result = validateDepGraph(tasks);
    const cyclicIssues = result.issues.filter((i) => i.code === 'E_CIRCULAR');
    expect(cyclicIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-epic gap detection
// ---------------------------------------------------------------------------

describe('detectCrossEpicGaps', () => {
  it('flags cross-epic dep when epic A has no dep on epic B → E_CROSS_EPIC_GAP', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E_A', title: 'Epic A', depends: [] }),
      makeEpic({ id: 'E_B', title: 'Epic B', depends: [] }),
      makeTask({ id: 'T_A1', title: 'Task in A', parentId: 'E_A', depends: ['T_B1'] }),
      makeTask({ id: 'T_B1', title: 'Task in B', parentId: 'E_B' }),
    ];
    const issues = detectCrossEpicGaps(tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('E_CROSS_EPIC_GAP');
    expect(issues[0]!.taskId).toBe('T_A1');
    expect(issues[0]!.epicA).toBe('E_A');
    expect(issues[0]!.epicB).toBe('E_B');
  });

  it('does NOT flag cross-epic dep when epic A has explicit dep on epic B', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E_A', title: 'Epic A', depends: ['E_B'] }),
      makeEpic({ id: 'E_B', title: 'Epic B', depends: [] }),
      makeTask({ id: 'T_A1', title: 'Task in A', parentId: 'E_A', depends: ['T_B1'] }),
      makeTask({ id: 'T_B1', title: 'Task in B', parentId: 'E_B' }),
    ];
    const issues = detectCrossEpicGaps(tasks);
    expect(issues).toHaveLength(0);
  });

  it('does NOT flag intra-epic deps', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E_A', title: 'Epic A' }),
      makeTask({ id: 'T1', title: 'Task 1', parentId: 'E_A' }),
      makeTask({ id: 'T2', title: 'Task 2', parentId: 'E_A', depends: ['T1'] }),
    ];
    const issues = detectCrossEpicGaps(tasks);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Stale dep detection
// ---------------------------------------------------------------------------

describe('detectStaleDeps', () => {
  it('flags dep to a cancelled task → E_STALE_DEP', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Active task', parentId: 'E001', depends: ['T002'] }),
      makeTask({ id: 'T002', title: 'Cancelled dep', parentId: 'E001', status: 'cancelled' }),
    ];
    const issues = detectStaleDeps(tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('E_STALE_DEP');
    expect(issues[0]!.taskId).toBe('T001');
    expect(issues[0]!.relatedIds).toContain('T002');
  });

  it('flags dep to a done-but-gates-not-passed task → E_STALE_DEP', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Active task', parentId: 'E001', depends: ['T002'] }),
      makeTask({
        id: 'T002',
        title: 'Done-but-no-pass dep',
        parentId: 'E001',
        status: 'done',
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true, testsPassed: false, qaPassed: false },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
          initializedAt: new Date().toISOString(),
        },
      }),
    ];
    const issues = detectStaleDeps(tasks);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('E_STALE_DEP');
  });

  it('does NOT flag dep to a done+gates-passed task', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Active task', parentId: 'E001', depends: ['T002'] }),
      makeTask({
        id: 'T002',
        title: 'Done-and-passed',
        parentId: 'E001',
        status: 'done',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
          initializedAt: new Date().toISOString(),
        },
      }),
    ];
    const issues = detectStaleDeps(tasks);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Clean graph
// ---------------------------------------------------------------------------

describe('validateDepGraph — clean graph', () => {
  it('returns valid:true and empty issues for a well-formed graph', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E_A', title: 'Epic A', depends: ['E_B'] }),
      makeEpic({ id: 'E_B', title: 'Epic B' }),
      makeTask({ id: 'T1', title: 'Task 1', parentId: 'E_A', depends: ['T2'] }),
      makeTask({ id: 'T2', title: 'Task 2', parentId: 'E_B', status: 'done' }),
    ];
    // T2 is done without verification object — no stale dep (no verification field means gates N/A)
    const result = validateDepGraph(tasks);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toContain('no issues found');
  });
});

// ---------------------------------------------------------------------------
// 6. --epic scoping via runValidation
// ---------------------------------------------------------------------------

describe('runValidation — epic scoping', () => {
  it('scopes validation to direct children of the given epicId', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic 1' }),
      makeEpic({ id: 'E002', title: 'Epic 2' }),
      // Orphan in E001's children scope
      makeTask({ id: 'T001', title: 'Task in E001', parentId: 'E001' }),
      // Orphan outside E001 scope — should NOT appear when scoped to E001
      makeTask({ id: 'T999', title: 'Unrelated orphan', parentId: undefined }),
    ];
    const result = runValidation(tasks, { epicId: 'E001' });
    // T999 is outside E001 children scope — should not be included
    const orphanIds = result.issues.filter((i) => i.code === 'E_ORPHAN').map((i) => i.taskId);
    expect(orphanIds).not.toContain('T999');
  });

  it('includes cross-epic gaps within the scoped task set', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E_X', title: 'Epic X', depends: [] }),
      makeEpic({ id: 'E_Y', title: 'Epic Y', depends: [] }),
      makeTask({ id: 'T_X1', title: 'Child of X', parentId: 'E_X', depends: ['T_Y1'] }),
      makeTask({ id: 'T_Y1', title: 'Child of Y', parentId: 'E_Y' }),
    ];
    // Scope to E_X — T_X1 is a direct child; T_Y1 is in the dep chain but not a child of E_X
    const result = runValidation(tasks, { epicId: 'E_X' });
    // T_X1's dep on T_Y1 is a missing ref in the scoped set (T_Y1 not in scope) OR cross-epic gap
    // Either way there should be an issue
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nearestEpic helper
// ---------------------------------------------------------------------------

describe('nearestEpic', () => {
  it('returns the direct parent epic ID when the task parent is an epic', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Epic' }),
      makeTask({ id: 'T001', title: 'Child', parentId: 'E001' }),
    ];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    expect(nearestEpic('T001', taskMap)).toBe('E001');
  });

  it('returns the epic itself when the task is an epic', () => {
    const tasks: Task[] = [makeEpic({ id: 'E001', title: 'Epic' })];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    expect(nearestEpic('E001', taskMap)).toBe('E001');
  });

  it('returns null for a top-level non-epic task', () => {
    const tasks: Task[] = [makeTask({ id: 'T001', title: 'Top-level task' })];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    expect(nearestEpic('T001', taskMap)).toBeNull();
  });

  it('walks up multiple levels to find the nearest epic', () => {
    const tasks: Task[] = [
      makeEpic({ id: 'E001', title: 'Grand-epic' }),
      makeTask({ id: 'T_MID', title: 'Middle task', type: 'task', parentId: 'E001' }),
      makeTask({ id: 'T_LEAF', title: 'Leaf task', parentId: 'T_MID' }),
    ];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    expect(nearestEpic('T_LEAF', taskMap)).toBe('E001');
  });
});
