/**
 * Tests for `renderGenericTree` — the renderer that drives `cleo tree <id>`
 * (T10134).
 *
 * Covers the canonical SG-TEMPLATE-CONFIG-SSOT-shaped saga (AC10) plus the
 * ancestor-banner + groups-edge prefix behaviour spelled out in the task
 * acceptance criteria. Fixtures are inlined (no DB) so the renderer is
 * exercised in isolation.
 *
 * @epic T10114
 * @task T10134
 * @see ADR-077-human-render-contract.md
 */

import { createAnimateContext } from '@cleocode/animations';
import type { FlatTreeNode, TreeResponse } from '@cleocode/contracts';
import type { GenericTreeMetadata, GenericTreeResult } from '@cleocode/core/internal';
import { describe, expect, it } from 'vitest';
import { renderGenericTree } from '../generic-tree.js';

/**
 * Forced-enabled context — bypasses the no-TTY guard inside
 * `createAnimateContext` so the renderer output is deterministic in CI.
 * Production callers never opt-in this way; they go through the format
 * context which respects TTY + NO_COLOR.
 */
const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

/** Build a `FlatTreeNode` with sensible defaults to keep fixtures terse. */
function node(
  overrides: Partial<FlatTreeNode<GenericTreeMetadata>> & {
    id: string;
    title: string;
    metadata: Partial<GenericTreeMetadata>;
  },
): FlatTreeNode<GenericTreeMetadata> {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    depth: overrides.depth ?? 0,
    kind: overrides.kind ?? 'task',
    status: overrides.status ?? 'pending',
    title: overrides.title,
    metadata: {
      edgeType: overrides.metadata.edgeType ?? 'parent',
      priority: overrides.metadata.priority ?? 'medium',
      depends: overrides.metadata.depends ?? [],
      blockedBy: overrides.metadata.blockedBy ?? [],
      ready: overrides.metadata.ready ?? false,
      ...(overrides.metadata.blockerChain !== undefined
        ? { blockerChain: overrides.metadata.blockerChain }
        : {}),
      ...(overrides.metadata.leafBlockers !== undefined
        ? { leafBlockers: overrides.metadata.leafBlockers }
        : {}),
    },
  };
}

/**
 * Build the canonical SG-TEMPLATE-CONFIG-SSOT-shaped fixture: 1 saga + 12
 * member epics + a couple of parent-edge children on the first member.
 *
 * Rows are emitted in PRE-ORDER so the renderer's flat-list-to-tree
 * reconstruction matches what `buildGenericTaskTree` produces in production.
 */
function sagaFixture(): GenericTreeResult {
  const tree: FlatTreeNode<GenericTreeMetadata>[] = [
    node({
      id: 'SG-TPL',
      title: 'SG-TEMPLATE-CONFIG-SSOT',
      kind: 'saga',
      status: 'pending',
      metadata: { edgeType: 'root' },
    }),
    // Member Epic 01 — visited first; its parent-edge children are emitted
    // immediately after it (DFS preorder).
    node({
      id: 'E-MEM-01',
      title: 'Member Epic 01',
      kind: 'epic',
      status: 'pending',
      parentId: 'SG-TPL',
      depth: 1,
      metadata: { edgeType: 'groups' },
    }),
    node({
      id: 'T-CHILD-01',
      title: 'Child task A',
      parentId: 'E-MEM-01',
      depth: 2,
      metadata: { edgeType: 'parent' },
    }),
    node({
      id: 'T-CHILD-02',
      title: 'Child task B',
      parentId: 'E-MEM-01',
      depth: 2,
      status: 'in_progress',
      metadata: { edgeType: 'parent' },
    }),
  ];
  // Remaining members 02–12 — no parent-edge children to emit.
  for (let i = 2; i <= 12; i++) {
    tree.push(
      node({
        id: `E-MEM-${i.toString().padStart(2, '0')}`,
        title: `Member Epic ${i.toString().padStart(2, '0')}`,
        kind: 'epic',
        status: 'pending',
        parentId: 'SG-TPL',
        depth: 1,
        metadata: { edgeType: 'groups' },
      }),
    );
  }

  const response: TreeResponse<GenericTreeMetadata> = {
    tree,
    root: 'SG-TPL',
    totalNodes: tree.length,
    maxDepth: 2,
  };

  return { tree: response, ancestors: [] };
}

describe('renderGenericTree (T10134)', () => {
  it('renders the canonical SG-TEMPLATE-CONFIG-SSOT shape with groups prefix', () => {
    const out = renderGenericTree(sagaFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });
    const lines = out.split('\n');

    // Root saga line — KindIcon.SAGA + StatusIcon.PENDING in Unicode.
    expect(lines[0]).toBe('🌲 SG-TEMPLATE-CONFIG-SSOT ⏳');

    // First member — groups-edge children carry RelationIcon.GROUPS (⊂)
    // prefix; connectors are Unicode box-drawing.
    expect(lines[1]).toBe('├─ 📋 ⊂ Member Epic 01 ⏳');

    // Child tasks live one level deeper under the first member.
    expect(lines[2]).toBe('│  ├─ • Child task A ⏳');
    expect(lines[3]).toBe('│  └─ • Child task B 🚧');

    // Last member — `└─` instead of `├─` because it's the last sibling.
    expect(lines[14]).toBe('└─ 📋 ⊂ Member Epic 12 ⏳');

    // 1 root + 12 members + 2 child tasks = 15 rows.
    expect(lines).toHaveLength(15);
  });

  it('emits the ancestor banner when the root has parent-chain ancestors', () => {
    const fixture = sagaFixture();
    const ancestors: ReadonlyArray<FlatTreeNode<GenericTreeMetadata>> = [
      node({
        id: 'E-PARENT',
        title: 'Parent Epic',
        kind: 'epic',
        metadata: { edgeType: 'parent' },
      }),
      node({
        id: 'SG-ROOT',
        title: 'Root Saga',
        kind: 'saga',
        metadata: { edgeType: 'parent' },
      }),
    ];
    const decorated: GenericTreeResult = { ...fixture, ancestors };
    const out = renderGenericTree(decorated, {
      withDeps: false,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });

    // Banner shows root → … → (here) in Unicode mode using `↑` + `›` arrows.
    // The first line MUST cover all ancestor kinds + the (here) terminator
    // so a user reading L-to-R sees the upward chain ending at the rendered root.
    const firstLine = out.split('\n')[0] ?? '';
    expect(firstLine).toContain('🌲 SG-ROOT');
    expect(firstLine).toContain('📋 E-PARENT');
    expect(firstLine).toContain('(here)');
    expect(firstLine.startsWith('↑')).toBe(true);
  });

  it('appends withDeps annotations beneath the tree', () => {
    const fixture = sagaFixture();
    // Inject a dep onto the first child task.
    const decoratedRows = fixture.tree.tree.map((n) =>
      n.id === 'T-CHILD-01' ? { ...n, metadata: { ...n.metadata, depends: ['T-OTHER'] } } : n,
    );
    const decorated: GenericTreeResult = {
      ...fixture,
      tree: { ...fixture.tree, tree: decoratedRows },
    };
    const out = renderGenericTree(decorated, {
      withDeps: true,
      withBlockers: false,
      quiet: false,
      ctx: enabledCtx,
    });
    expect(out).toContain('T-CHILD-01 depends-on: T-OTHER');
  });

  it('quiet mode emits one ID per line in preorder', () => {
    const out = renderGenericTree(sagaFixture(), {
      withDeps: false,
      withBlockers: false,
      quiet: true,
      ctx: enabledCtx,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('SG-TPL');
    expect(lines[1]).toBe('E-MEM-01');
    expect(lines[2]).toBe('T-CHILD-01');
    expect(lines).toHaveLength(15);
  });
});
