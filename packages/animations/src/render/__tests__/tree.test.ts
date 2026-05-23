/**
 * Tests for renderTree — box-drawing hierarchy with depth, fold, icons.
 */

import type {
  FlatTreeNode,
  TreeNodeKind,
  TreeNodeStatus,
  TreeResponse,
} from '@cleocode/contracts/render/tree.js';
import { describe, expect, it } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from '../../animate-context.js';
import { renderTree } from '../tree.js';

const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

// noColorCtx is silenced by createAnimateContext (NO_COLOR halts rendering).
// To test the ASCII glyph path, pass `asciiBoxDrawing: true` while keeping the
// enabled context — that's the public knob for caller-driven ASCII output.

function node(
  id: string,
  parentId: string | null,
  depth: number,
  kind: TreeNodeKind,
  status: TreeNodeStatus,
  title: string,
): FlatTreeNode<Record<string, never>> {
  return { id, parentId, depth, kind, status, title, metadata: {} };
}

/** Canonical Saga family — 1 saga + 3 epics + 6 tasks (2 per epic). */
const SAGA_FAMILY: TreeResponse<Record<string, never>> = {
  root: 'SG-DEMO',
  totalNodes: 10,
  maxDepth: 2,
  tree: [
    node('SG-DEMO', null, 0, 'saga', 'done', 'SG-DEMO demo saga'),
    node('T1', 'SG-DEMO', 1, 'epic', 'done', 'Epic one'),
    node('T1a', 'T1', 2, 'task', 'done', 'Task 1a'),
    node('T1b', 'T1', 2, 'task', 'done', 'Task 1b'),
    node('T2', 'SG-DEMO', 1, 'epic', 'in_progress', 'Epic two'),
    node('T2a', 'T2', 2, 'task', 'in_progress', 'Task 2a'),
    node('T2b', 'T2', 2, 'task', 'pending', 'Task 2b'),
    node('T3', 'SG-DEMO', 1, 'epic', 'pending', 'Epic three'),
    node('T3a', 'T3', 2, 'task', 'pending', 'Task 3a'),
    node('T3b', 'T3', 2, 'task', 'blocked', 'Task 3b'),
  ],
};

describe('renderTree', () => {
  it('returns empty string when context is silent', () => {
    expect(renderTree(SAGA_FAMILY, { ctx: SILENT_CONTEXT })).toBe('');
  });

  it('returns empty string for an empty tree', () => {
    expect(
      renderTree({ tree: [], root: 'X', totalNodes: 0, maxDepth: 0 }, { ctx: enabledCtx }),
    ).toBe('');
  });

  it('renders the canonical saga family (emoji)', () => {
    expect(renderTree(SAGA_FAMILY, { ctx: enabledCtx })).toMatchInlineSnapshot(`
      "🌲 SG-DEMO demo saga ✅
      ├─ 📋 Epic one ✅
      │  ├─ • Task 1a ✅
      │  └─ • Task 1b ✅
      ├─ 📋 Epic two 🚧
      │  ├─ • Task 2a 🚧
      │  └─ • Task 2b ⏳
      └─ 📋 Epic three ⏳
         ├─ • Task 3a ⏳
         └─ • Task 3b 🚪"
    `);
  });

  it('renders the canonical saga family (ASCII)', () => {
    expect(
      renderTree(SAGA_FAMILY, { ctx: enabledCtx, asciiBoxDrawing: true }),
    ).toMatchInlineSnapshot(`
      "SG SG-DEMO demo saga [x]
      +- E Epic one [x]
      |  +- - Task 1a [x]
      |  +- - Task 1b [x]
      +- E Epic two [~]
      |  +- - Task 2a [~]
      |  +- - Task 2b [ ]
      +- E Epic three [ ]
         +- - Task 3a [ ]
         +- - Task 3b [!]"
    `);
  });

  it('renders a deeply nested single-path tree (depth 3+)', () => {
    const deep: TreeResponse<Record<string, never>> = {
      root: 'SG-X',
      totalNodes: 4,
      maxDepth: 3,
      tree: [
        node('SG-X', null, 0, 'saga', 'in_progress', 'Saga X'),
        node('E1', 'SG-X', 1, 'epic', 'in_progress', 'Epic one'),
        node('T1', 'E1', 2, 'task', 'in_progress', 'Task one'),
        node('S1', 'T1', 3, 'subtask', 'done', 'Subtask one'),
      ],
    };
    expect(renderTree(deep, { ctx: enabledCtx })).toMatchInlineSnapshot(`
      "🌲 Saga X 🚧
      └─ 📋 Epic one 🚧
         └─ • Task one 🚧
            └─ ◦ Subtask one ✅"
    `);
  });

  it('folds a parent with more direct children than foldAt', () => {
    const kids: FlatTreeNode<Record<string, never>>[] = [];
    for (let i = 1; i <= 60; i++) {
      kids.push(node(`T${i}`, 'E-BIG', 1, 'task', 'pending', `Task ${i}`));
    }
    const big: TreeResponse<Record<string, never>> = {
      root: 'E-BIG',
      totalNodes: 61,
      maxDepth: 1,
      tree: [node('E-BIG', null, 0, 'epic', 'in_progress', 'Big epic'), ...kids],
    };
    const out = renderTree(big, { ctx: enabledCtx, foldAt: 50 });
    const lines = out.split('\n');
    // 1 root + 49 visible children + 1 fold summary = 51 lines.
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe('📋 Big epic 🚧');
    expect(lines[49]).toBe('├─ • Task 49 ⏳');
    expect(lines[50]).toBe('└─ … and 11 more tasks (run cleo tree E-BIG --depth +1 to expand)');
  });

  it('renders nothing when the root cannot be resolved', () => {
    const bad: TreeResponse<Record<string, never>> = {
      root: 'missing',
      totalNodes: 1,
      maxDepth: 0,
      tree: [node('present', null, 0, 'task', 'done', 'present')],
    };
    expect(renderTree(bad, { ctx: enabledCtx })).toBe('');
  });
});
