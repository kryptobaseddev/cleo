/**
 * T10576 WorkGraph hierarchy invariant validator acceptance coverage.
 *
 * These tests lock the runtime contract that mirrors the SQLite trigger matrix:
 * sagas and epics are roots, epics contain tasks/subtasks, tasks contain only
 * subtasks, and subtasks are leaves.
 *
 * @task T10576
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import {
  E_WORKGRAPH_PARENT_TYPE_MATRIX,
  validateWorkGraphHierarchy,
  type WorkGraphHierarchyInputNode,
  type WorkGraphHierarchyViolation,
} from '../index.js';

const node = (overrides: Partial<WorkGraphHierarchyInputNode>): WorkGraphHierarchyInputNode => ({
  id: overrides.id ?? 'T1',
  type: overrides.type ?? 'task',
  parentId: overrides.parentId,
});

describe('validateWorkGraphHierarchy', () => {
  it('accepts the canonical saga -> epic -> task -> subtask hierarchy shape', () => {
    const result = validateWorkGraphHierarchy([
      node({ id: 'SG1', type: 'saga' }),
      node({ id: 'E1', type: 'epic' }),
      node({ id: 'T1', type: 'task', parentId: 'E1' }),
      node({ id: 'ST1', type: 'subtask', parentId: 'T1' }),
      node({ id: 'ST2', type: 'subtask', parentId: 'E1' }),
    ]);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects saga parent_id so Saga membership stays relation-backed', () => {
    const result = validateWorkGraphHierarchy([
      node({ id: 'SG1', type: 'saga', parentId: 'E1' }),
      node({ id: 'E1', type: 'epic' }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        code: E_WORKGRAPH_PARENT_TYPE_MATRIX,
        taskId: 'SG1',
        parentId: 'E1',
        taskType: 'saga',
        parentType: 'epic',
      }),
    ]);
  });

  it('rejects epic parents, task-under-task, and child-under-subtask matrix breaches', () => {
    const result = validateWorkGraphHierarchy([
      node({ id: 'E1', type: 'epic' }),
      node({ id: 'E2', type: 'epic', parentId: 'E1' }),
      node({ id: 'T1', type: 'task', parentId: 'E1' }),
      node({ id: 'T2', type: 'task', parentId: 'T1' }),
      node({ id: 'ST1', type: 'subtask', parentId: 'T1' }),
      node({ id: 'ST2', type: 'subtask', parentId: 'ST1' }),
    ]);

    expect(result.valid).toBe(false);
    const violationTaskIds = result.violations.map(
      (violation: WorkGraphHierarchyViolation) => violation.taskId,
    );
    const violationCodes = result.violations.map(
      (violation: WorkGraphHierarchyViolation) => violation.code,
    );

    expect(violationTaskIds).toEqual(['E2', 'T2', 'ST2']);
    expect(violationCodes).toEqual([
      E_WORKGRAPH_PARENT_TYPE_MATRIX,
      E_WORKGRAPH_PARENT_TYPE_MATRIX,
      E_WORKGRAPH_PARENT_TYPE_MATRIX,
    ]);
  });

  it('can throw with stable diagnostics for callers that need fail-fast enforcement', () => {
    expect(() =>
      validateWorkGraphHierarchy(
        [
          node({ id: 'E1', type: 'epic' }),
          node({ id: 'T1', type: 'task', parentId: 'E1' }),
          node({ id: 'T2', type: 'task', parentId: 'T1' }),
        ],
        { throwOnViolation: true },
      ),
    ).toThrow(/E_WORKGRAPH_PARENT_TYPE_MATRIX: task T2/);
  });
});
