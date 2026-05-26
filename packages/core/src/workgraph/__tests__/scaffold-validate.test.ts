/**
 * T10632 acceptance coverage for WorkGraph scaffold dry-run validation.
 *
 * Locks AC1 (YAML/JSON validates saga/epics/tasks/docs/relations),
 * AC2 (IDs/edges/fanout checked), and AC3 (dry-run default available).
 *
 * @task T10632
 * @saga T10538
 * @epic T10547
 */

import type { WorkGraphHierarchyInputNode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  E_WORKGRAPH_SCAFFOLD_DUPLICATE_ID,
  E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED,
  E_WORKGRAPH_SCAFFOLD_INVALID_EDGE_KIND,
  E_WORKGRAPH_SCAFFOLD_INVALID_TYPE,
  E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT,
  E_WORKGRAPH_SCAFFOLD_MISSING_ID,
  E_WORKGRAPH_SCAFFOLD_SELF_LOOP,
  validateWorkGraphScaffold,
} from '../scaffold-validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function epicNode(id: string): WorkGraphHierarchyInputNode {
  return { id, type: 'epic' };
}

function taskNode(id: string, parentId: string): WorkGraphHierarchyInputNode {
  return { id, type: 'task', parentId };
}

function subtaskNode(id: string, parentId: string): WorkGraphHierarchyInputNode {
  return { id, type: 'subtask', parentId };
}

function depEdge(fromId: string, toId: string) {
  return { source: 'dependency' as const, fromId, toId, kind: 'depends_on' as const };
}

function relEdge(fromId: string, toId: string, relationType: string = 'related') {
  return {
    source: 'relation' as const,
    fromId,
    toId,
    kind: 'relates_to' as const,
    relationType: relationType as
      | 'related'
      | 'blocks'
      | 'duplicates'
      | 'absorbs'
      | 'fixes'
      | 'extends'
      | 'supersedes'
      | 'groups',
    reason: 'test relation',
  };
}

// ---------------------------------------------------------------------------
// AC1: YAML/JSON validates saga/epics/tasks/docs/relations
// ---------------------------------------------------------------------------

describe('AC1: scaffold validates saga/epic/task/subtask nodes and edges', () => {
  it('accepts a valid saga with epics and tasks', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'SG1',
      nodes: [
        { id: 'SG1', type: 'saga' },
        { id: 'E1', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'E1' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.hierarchy.valid).toBe(true);
  });

  it('accepts a valid epic→task→subtask hierarchy', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [
        { id: 'E1', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'E1' },
        { id: 'ST1', type: 'subtask', parentId: 'T1' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.hierarchy.valid).toBe(true);
  });

  it('accepts edges between valid nodes', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [
        { id: 'E1', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'E1' },
        { id: 'T2', type: 'task', parentId: 'E1' },
      ],
      edges: [depEdge('T2', 'T1'), relEdge('T1', 'T2')],
    });

    expect(result.valid).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects a task whose parent is a subtask (hierarchy violation)', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [
        { id: 'E1', type: 'epic' },
        { id: 'ST1', type: 'subtask', parentId: 'E1' },
        { id: 'T1', type: 'task', parentId: 'ST1' },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.hierarchy.valid).toBe(false);
    expect(result.hierarchy.violations.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.code === 'E_WORKGRAPH_PARENT_TYPE_MATRIX')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: IDs/edges/fanout checked
// ---------------------------------------------------------------------------

describe('AC2: IDs, edges, and fanout checks', () => {
  it('rejects nodes with empty or missing IDs', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'ROOT',
      nodes: [
        { id: '', type: 'epic' },
        { id: '  ', type: 'epic' },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_MISSING_ID)).toHaveLength(2);
  });

  it('rejects duplicate node IDs', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [
        { id: 'E1', type: 'epic' },
        { id: 'E1', type: 'epic' },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_DUPLICATE_ID)).toHaveLength(
      1,
    );
  });

  it('rejects nodes with invalid types', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'ROOT',
      nodes: [{ id: 'N1', type: 'invalid_type' as any }],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_INVALID_TYPE)).toHaveLength(
      1,
    );
  });

  it('rejects edges referencing non-existent source nodes', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1'), taskNode('T1', 'E1')],
      edges: [depEdge('MISSING', 'T1')],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT),
    ).toHaveLength(1);
  });

  it('rejects edges referencing non-existent target nodes', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1'), taskNode('T1', 'E1')],
      edges: [depEdge('T1', 'MISSING')],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_MISSING_ENDPOINT),
    ).toHaveLength(1);
  });

  it('rejects self-loop edges', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1')],
      edges: [depEdge('E1', 'E1')],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_SELF_LOOP)).toHaveLength(1);
  });

  it('rejects edges with invalid kind', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1'), taskNode('T1', 'E1')],
      edges: [
        { source: 'dependency' as const, fromId: 'E1', toId: 'T1', kind: 'invalid_kind' as any },
      ],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_INVALID_EDGE_KIND),
    ).toHaveLength(1);
  });

  it('flags fanout exceeding the configured maxFanout', () => {
    const nodes: WorkGraphHierarchyInputNode[] = [
      epicNode('E1'),
      taskNode('T1', 'E1'),
      taskNode('T2', 'E1'),
      taskNode('T3', 'E1'),
    ];

    const result = validateWorkGraphScaffold({ rootId: 'E1', nodes }, { maxFanout: 2 });

    expect(result.valid).toBe(true); // fanout is a warning, not an error
    expect(
      result.issues.filter(
        (i) => i.code === E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED && i.severity === 'warning',
      ),
    ).toHaveLength(1);
  });

  it('does not flag fanout at or under the configured limit', () => {
    const nodes: WorkGraphHierarchyInputNode[] = [
      epicNode('E1'),
      taskNode('T1', 'E1'),
      taskNode('T2', 'E1'),
    ];

    const result = validateWorkGraphScaffold({ rootId: 'E1', nodes }, { maxFanout: 3 });

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.code === E_WORKGRAPH_SCAFFOLD_FANOUT_EXCEEDED)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: dry-run default available
// ---------------------------------------------------------------------------

describe('AC3: dry-run default is true', () => {
  it('defaults dryRun to true when not specified', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1')],
    });

    expect(result.dryRun).toBe(true);
  });

  it('echoes explicit dryRun: true', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1')],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
  });

  it('echoes explicit dryRun: false', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1')],
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('accepts empty nodes array (root-only scope)', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'ROOT',
      nodes: [],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.hierarchy.valid).toBe(true);
  });

  it('accepts undefined edges', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [epicNode('E1'), taskNode('T1', 'E1')],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts all four valid types', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'SG1',
      nodes: [
        { id: 'SG1', type: 'saga' },
        { id: 'E1', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'E1' },
        { id: 'ST1', type: 'subtask', parentId: 'T1' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('returns multiple issues when scaffold has several problems', () => {
    const result = validateWorkGraphScaffold({
      rootId: 'E1',
      nodes: [
        { id: 'E1', type: 'invalid' as any },
        { id: 'E1', type: 'epic' }, // duplicate
        { id: '', type: 'epic' }, // missing ID
      ],
      edges: [depEdge('MISSING', 'E1'), depEdge('E1', 'E1')],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });
});
