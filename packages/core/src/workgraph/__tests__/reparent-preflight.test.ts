/**
 * T10578 WorkGraph reparent preflight acceptance coverage.
 *
 * Locks cycle detection, hierarchy depth enforcement, and typed diagnostics for
 * callers before they mutate `tasks.parent_id`.
 *
 * @task T10578
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import {
  E_WORKGRAPH_CONTAINMENT_CYCLE,
  E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
  E_WORKGRAPH_PARENT_TYPE_MATRIX,
  preflightWorkGraphReparent,
  type WorkGraphHierarchyInputNode,
} from '../index.js';

const hierarchy: readonly WorkGraphHierarchyInputNode[] = [
  { id: 'E1', type: 'epic' },
  { id: 'T1', type: 'task', parentId: 'E1' },
  { id: 'ST1', type: 'subtask', parentId: 'T1' },
  { id: 'E2', type: 'epic' },
  { id: 'T2', type: 'task', parentId: 'E2' },
];

describe('preflightWorkGraphReparent', () => {
  it('rejects moves that would create a parent_id containment cycle', () => {
    const result = preflightWorkGraphReparent({
      nodes: hierarchy,
      taskId: 'T1',
      newParentId: 'ST1',
    });

    expect(result.allowed).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: E_WORKGRAPH_CONTAINMENT_CYCLE,
        taskId: 'T1',
        parentId: 'ST1',
        path: ['T1', 'ST1', 'T1'],
      }),
      expect.objectContaining({
        code: E_WORKGRAPH_PARENT_TYPE_MATRIX,
        taskId: 'T1',
        parentId: 'ST1',
        parentType: 'subtask',
      }),
    ]);
  });

  it('rejects moves that would exceed the configured containment depth', () => {
    const result = preflightWorkGraphReparent({
      nodes: hierarchy,
      taskId: 'T2',
      newParentId: 'ST1',
      maxDepth: 2,
    });

    expect(result.allowed).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
        taskId: 'T2',
        parentId: 'ST1',
        depth: 3,
        maxDepth: 2,
        path: ['E1', 'T1', 'ST1', 'T2'],
      }),
    );
  });

  it('returns typed findings while allowing structurally safe reparent proposals', () => {
    const result = preflightWorkGraphReparent({
      nodes: hierarchy,
      taskId: 'T2',
      newParentId: 'E1',
    });

    expect(result).toEqual({
      allowed: true,
      findings: [],
      proposedParentId: 'E1',
      taskId: 'T2',
    });
  });
});
