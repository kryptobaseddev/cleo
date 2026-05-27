/**
 * T10583 WorkGraph structural validation acceptance coverage.
 *
 * Locks typed cycles/orphans/depth/fanout diagnostics, missing Wave 0 reporting,
 * and finding pagination for large graph validation output.
 *
 * @task T10583
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import {
  E_WORKGRAPH_CONTAINMENT_CYCLE,
  E_WORKGRAPH_FANOUT_EXCEEDED,
  E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
  E_WORKGRAPH_MISSING_WAVE_ZERO,
  E_WORKGRAPH_ORPHANED_NODE,
  validateWorkGraphStructure,
  type WorkGraphStructureInputNode,
} from '../index.js';

describe('validateWorkGraphStructure', () => {
  it('returns typed cycle, orphan, depth, fanout, and missing Wave 0 findings', () => {
    const nodes: readonly WorkGraphStructureInputNode[] = [
      { id: 'E1', type: 'epic', wave: 1 },
      { id: 'T1', type: 'task', parentId: 'E1', wave: 1 },
      { id: 'ST1', type: 'subtask', parentId: 'T1', wave: 1 },
      { id: 'TOO_DEEP', type: 'subtask', parentId: 'ST1', wave: 1 },
      { id: 'CYCLE_A', type: 'task', parentId: 'CYCLE_B', wave: 1 },
      { id: 'CYCLE_B', type: 'subtask', parentId: 'CYCLE_A', wave: 1 },
      { id: 'ORPHAN', type: 'task', parentId: 'MISSING', wave: 1 },
      { id: 'FANOUT_1', type: 'task', parentId: 'E1', wave: 1 },
      { id: 'FANOUT_2', type: 'task', parentId: 'E1', wave: 1 },
      { id: 'FANOUT_3', type: 'task', parentId: 'E1', wave: 1 },
    ];

    const result = validateWorkGraphStructure(nodes, {
      scopeId: 'T10542',
      maxDepth: 2,
      maxFanout: 3,
    });

    expect(result.valid).toBe(false);
    expect(result.totalFindings).toBe(5);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: E_WORKGRAPH_CONTAINMENT_CYCLE,
        taskId: 'CYCLE_A',
        path: ['CYCLE_A', 'CYCLE_B', 'CYCLE_A'],
      }),
      expect.objectContaining({
        code: E_WORKGRAPH_ORPHANED_NODE,
        taskId: 'ORPHAN',
        parentId: 'MISSING',
      }),
      expect.objectContaining({
        code: E_WORKGRAPH_MAX_DEPTH_EXCEEDED,
        taskId: 'TOO_DEEP',
        depth: 3,
        maxDepth: 2,
        path: ['E1', 'T1', 'ST1', 'TOO_DEEP'],
      }),
      expect.objectContaining({
        code: E_WORKGRAPH_FANOUT_EXCEEDED,
        parentId: 'E1',
        fanout: 4,
        maxFanout: 3,
      }),
      expect.objectContaining({
        code: E_WORKGRAPH_MISSING_WAVE_ZERO,
        scopeId: 'T10542',
        waves: [1],
      }),
    ]);
  });

  it('paginates large structural finding sets with stable next cursors', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      id: `T${index}`,
      type: 'task' as const,
      parentId: `MISSING_${index}`,
      wave: 0,
    }));

    const firstPage = validateWorkGraphStructure(nodes, { limit: 2 });
    const secondPage = validateWorkGraphStructure(nodes, {
      cursor: firstPage.pageInfo.nextCursor,
      limit: 2,
    });

    expect(firstPage.findings.map((finding) => finding.taskId)).toEqual(['T0', 'T1']);
    expect(firstPage.totalFindings).toBe(6);
    expect(firstPage.pageInfo).toEqual({ hasMore: true, nextCursor: '2' });
    expect(secondPage.findings.map((finding) => finding.taskId)).toEqual(['T2', 'T3']);
    expect(secondPage.pageInfo).toEqual({ hasMore: true, nextCursor: '4' });
  });
});
