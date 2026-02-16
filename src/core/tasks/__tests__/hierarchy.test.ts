/**
 * Tests for task hierarchy operations.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  getChildren,
  getChildIds,
  getDescendants,
  getDescendantIds,
  getParentChain,
  getParentChainIds,
  getDepth,
  getRootAncestor,
  isAncestorOf,
  isDescendantOf,
  getSiblings,
  validateHierarchy,
  wouldCreateCircle,
  buildTree,
  flattenTree,
} from '../hierarchy.js';
import type { Task } from '../../../types/task.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('getChildren', () => {
  it('returns direct children of a task', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
      makeTask({ id: 'T004', parentId: 'T002' }),
      makeTask({ id: 'T005' }),
    ];
    const children = getChildren('T001', tasks);
    expect(children).toHaveLength(2);
    expect(children.map(c => c.id)).toEqual(['T002', 'T003']);
  });

  it('returns empty array for leaf tasks', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
    ];
    expect(getChildren('T001', tasks)).toHaveLength(0);
  });

  it('returns empty array for nonexistent parent', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getChildren('T999', tasks)).toHaveLength(0);
  });
});

describe('getChildIds', () => {
  it('returns child IDs', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
    ];
    expect(getChildIds('T001', tasks)).toEqual(['T002', 'T003']);
  });
});

describe('getDescendants', () => {
  it('returns all descendants recursively', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
      makeTask({ id: 'T004', parentId: 'T002' }),
      makeTask({ id: 'T005', parentId: 'T004' }),
    ];
    const desc = getDescendants('T001', tasks);
    expect(desc).toHaveLength(4);
    expect(desc.map(d => d.id).sort()).toEqual(['T002', 'T003', 'T004', 'T005']);
  });

  it('returns empty array for leaf', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getDescendants('T001', tasks)).toHaveLength(0);
  });

  it('handles circular parentId references gracefully', () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T002' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
    ];
    // Should not infinite loop
    const desc = getDescendants('T001', tasks);
    expect(desc.map(d => d.id)).toContain('T002');
  });
});

describe('getDescendantIds', () => {
  it('returns all descendant IDs', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    expect(getDescendantIds('T001', tasks).sort()).toEqual(['T002', 'T003']);
  });
});

describe('getParentChain', () => {
  it('returns parent chain from immediate to root', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    const chain = getParentChain('T003', tasks);
    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe('T002');
    expect(chain[1].id).toBe('T001');
  });

  it('returns empty array for root tasks', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getParentChain('T001', tasks)).toHaveLength(0);
  });

  it('handles circular parentId without infinite loop', () => {
    const tasks = [
      makeTask({ id: 'T001', parentId: 'T002' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
    ];
    const chain = getParentChain('T001', tasks);
    // Should terminate and return what it can
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe('getParentChainIds', () => {
  it('returns parent chain IDs', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    expect(getParentChainIds('T003', tasks)).toEqual(['T002', 'T001']);
  });
});

describe('getDepth', () => {
  it('returns 0 for root tasks', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getDepth('T001', tasks)).toBe(0);
  });

  it('returns 1 for direct children', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
    ];
    expect(getDepth('T002', tasks)).toBe(1);
  });

  it('returns 2 for grandchildren', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    expect(getDepth('T003', tasks)).toBe(2);
  });
});

describe('getRootAncestor', () => {
  it('returns the root ancestor', () => {
    const tasks = [
      makeTask({ id: 'T001', type: 'epic' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    const root = getRootAncestor('T003', tasks);
    expect(root?.id).toBe('T001');
  });

  it('returns null for root tasks', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getRootAncestor('T001', tasks)).toBeNull();
  });
});

describe('isAncestorOf', () => {
  const tasks = [
    makeTask({ id: 'T001' }),
    makeTask({ id: 'T002', parentId: 'T001' }),
    makeTask({ id: 'T003', parentId: 'T002' }),
  ];

  it('returns true when ancestor relationship exists', () => {
    expect(isAncestorOf('T001', 'T003', tasks)).toBe(true);
    expect(isAncestorOf('T001', 'T002', tasks)).toBe(true);
  });

  it('returns false when no ancestor relationship', () => {
    expect(isAncestorOf('T003', 'T001', tasks)).toBe(false);
    expect(isAncestorOf('T002', 'T001', tasks)).toBe(false);
  });
});

describe('isDescendantOf', () => {
  const tasks = [
    makeTask({ id: 'T001' }),
    makeTask({ id: 'T002', parentId: 'T001' }),
    makeTask({ id: 'T003', parentId: 'T002' }),
  ];

  it('returns true when descendant relationship exists', () => {
    expect(isDescendantOf('T003', 'T001', tasks)).toBe(true);
  });

  it('returns false when no descendant relationship', () => {
    expect(isDescendantOf('T001', 'T003', tasks)).toBe(false);
  });
});

describe('getSiblings', () => {
  it('returns siblings with same parent', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
      makeTask({ id: 'T004', parentId: 'T001' }),
    ];
    const siblings = getSiblings('T002', tasks);
    expect(siblings).toHaveLength(2);
    expect(siblings.map(s => s.id).sort()).toEqual(['T003', 'T004']);
  });

  it('returns root-level siblings', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003' }),
    ];
    const siblings = getSiblings('T001', tasks);
    expect(siblings).toHaveLength(2);
  });

  it('returns empty for nonexistent task', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(getSiblings('T999', tasks)).toHaveLength(0);
  });
});

describe('validateHierarchy', () => {
  it('accepts null parent (root task)', () => {
    const result = validateHierarchy(null, []);
    expect(result.valid).toBe(true);
  });

  it('rejects nonexistent parent', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const result = validateHierarchy('T999', tasks);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_PARENT_NOT_FOUND');
  });

  it('rejects depth exceeding MAX_DEPTH', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    // Adding child to T003 would make depth 3 which equals MAX_DEPTH
    const result = validateHierarchy('T003', tasks);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_DEPTH_EXCEEDED');
  });

  it('rejects exceeding sibling limit', () => {
    const children = Array.from({ length: 7 }, (_, i) =>
      makeTask({ id: `T00${i + 2}`, parentId: 'T001' }),
    );
    const tasks = [makeTask({ id: 'T001' }), ...children];
    const result = validateHierarchy('T001', tasks);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('E_SIBLING_LIMIT');
  });

  it('accepts valid parent within limits', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
    ];
    const result = validateHierarchy('T001', tasks);
    expect(result.valid).toBe(true);
  });
});

describe('wouldCreateCircle', () => {
  it('detects self-assignment', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(wouldCreateCircle('T001', 'T001', tasks)).toBe(true);
  });

  it('detects parent-to-descendant assignment', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
    ];
    expect(wouldCreateCircle('T001', 'T003', tasks)).toBe(true);
  });

  it('allows valid reassignment', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
    ];
    expect(wouldCreateCircle('T003', 'T002', tasks)).toBe(false);
  });
});

describe('buildTree', () => {
  it('builds tree from flat task list', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T001' }),
      makeTask({ id: 'T004', parentId: 'T002' }),
    ];
    const tree = buildTree(tasks);
    expect(tree).toHaveLength(1); // One root
    expect(tree[0].task.id).toBe('T001');
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].children).toHaveLength(1);
  });

  it('handles multiple roots', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
    ];
    const tree = buildTree(tasks);
    expect(tree).toHaveLength(2);
  });

  it('handles empty list', () => {
    expect(buildTree([])).toHaveLength(0);
  });
});

describe('flattenTree', () => {
  it('flattens tree back to list in depth-first order', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', parentId: 'T001' }),
      makeTask({ id: 'T003', parentId: 'T002' }),
      makeTask({ id: 'T004', parentId: 'T001' }),
    ];
    const tree = buildTree(tasks);
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(4);
    expect(flat[0].id).toBe('T001');
    expect(flat[1].id).toBe('T002');
    expect(flat[2].id).toBe('T003');
    expect(flat[3].id).toBe('T004');
  });
});
