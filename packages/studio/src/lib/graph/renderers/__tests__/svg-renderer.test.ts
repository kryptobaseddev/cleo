/**
 * Unit tests for the pure exports of {@link SvgRenderer}.
 *
 * Vitest in studio runs under `environment: 'node'` (see
 * `vitest.config.ts`), so `.svelte` components are not mountable. We
 * only test the pure helpers re-exported from the module-level script
 * block: `endpointId`, `focusOrder`, plus a sanity assertion against
 * the edge-kind contract imported from `$lib/graph/edge-kinds`.
 *
 * Coverage:
 *
 * 1. `endpointId` resolves string ids directly.
 * 2. `endpointId` resolves node references to their id.
 * 3. `focusOrder` sorts by weight desc, id asc (stable).
 * 4. Every `EdgeKind` from the kit types has a matching `EDGE_STYLE`
 *    entry with a `var(--edge-*)` token reference (no hex literal).
 *
 * @task T990
 * @wave 1C
 */

import { describe, expect, it } from 'vitest';

import { ALL_EDGE_KINDS, EDGE_STYLE } from '../../edge-kinds.js';
import type { GraphNode } from '../../types.js';
import { endpointId, focusOrder } from '../SvgRenderer.svelte';

// ---------------------------------------------------------------------------
// endpointId
// ---------------------------------------------------------------------------

describe('endpointId', () => {
  it('returns the string when the endpoint is already an id', () => {
    expect(endpointId('T1')).toBe('T1');
  });

  it('returns node.id when the endpoint has been resolved to a node', () => {
    const node = {
      id: 'T2',
      x: 0,
      y: 0,
      substrate: 'tasks' as const,
      kind: 'task',
      label: 'Task',
    };
    expect(endpointId(node)).toBe('T2');
  });
});

// ---------------------------------------------------------------------------
// focusOrder
// ---------------------------------------------------------------------------

describe('focusOrder', () => {
  const mkNode = (id: string, weight?: number): GraphNode => ({
    id,
    substrate: 'tasks',
    kind: 'task',
    label: id,
    weight,
  });

  it('sorts highest-weight nodes first', () => {
    const out = focusOrder([mkNode('A', 0.2), mkNode('B', 0.9), mkNode('C', 0.5)]);
    expect(out).toEqual(['B', 'C', 'A']);
  });

  it('breaks ties deterministically on id', () => {
    const out = focusOrder([mkNode('Y', 0.5), mkNode('X', 0.5), mkNode('Z', 0.5)]);
    expect(out).toEqual(['X', 'Y', 'Z']);
  });

  it('defaults missing weights to zero', () => {
    const out = focusOrder([mkNode('A'), mkNode('B', 0.1)]);
    expect(out).toEqual(['B', 'A']);
  });
});

// ---------------------------------------------------------------------------
// Edge style invariants
// ---------------------------------------------------------------------------

describe('EDGE_STYLE contract', () => {
  it('registers a style for every declared EdgeKind', () => {
    for (const kind of ALL_EDGE_KINDS) {
      expect(EDGE_STYLE[kind]).toBeDefined();
    }
  });

  it('uses only `var(--edge-*)` token references (no hex literals)', () => {
    for (const kind of ALL_EDGE_KINDS) {
      const style = EDGE_STYLE[kind];
      expect(style.color).toMatch(/^var\(--edge-[a-z0-9-]+\)$/);
    }
  });

  it('gives the 3 task edge kinds distinct dash patterns', () => {
    // parent = solid (no dash); blocks = dashed; depends = solid (token set)
    expect(EDGE_STYLE.parent.dash).toBeUndefined();
    expect(EDGE_STYLE.blocks.dash).toBe('6 3');
    // `depends` in this contract is solid — distinct via colour.
    expect(EDGE_STYLE.depends.color).toBe('var(--edge-workflow-soft)');
    expect(EDGE_STYLE.parent.color).toBe('var(--edge-structural)');
    expect(EDGE_STYLE.blocks.color).toBe('var(--edge-workflow)');
  });
});
