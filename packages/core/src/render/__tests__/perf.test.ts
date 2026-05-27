/**
 * `renderEnvelopeForHuman` perf-budget regression contract.
 *
 * Asserts wall-clock latency budgets for the render path per ADR-077 §7. Runs
 * on every CI build — not nightly-gated — so a regression surfaces in the
 * same PR that introduced it.
 *
 * @epic T10114
 * @task T10136
 */

import type { FlatTreeNode, RenderableEnvelope } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { renderEnvelopeForHuman } from '../render-envelope.js';

interface SyntheticRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

interface SyntheticNodeMeta {
  readonly note: string;
}

function buildTable(rows: number): RenderableEnvelope<SyntheticRow> {
  return {
    kind: 'table',
    data: {
      total: rows,
      schema: {
        columns: [
          { key: 'id', header: 'ID' },
          { key: 'title', header: 'Title' },
          { key: 'status', header: 'Status' },
        ],
      },
      rows: Array.from({ length: rows }, (_, i) => ({
        id: `T${10000 + i}`,
        title: `Synthetic task title number ${i}`,
        status: ['pending', 'in_progress', 'done'][i % 3] ?? 'pending',
      })),
    },
  };
}

function buildTree(nodes: number, fanout = 5): RenderableEnvelope<SyntheticNodeMeta> {
  const tree: Array<FlatTreeNode<SyntheticNodeMeta>> = [];
  for (let i = 0; i < nodes; i++) {
    const depth = Math.floor(Math.log(i + 1) / Math.log(fanout));
    const parentId = i === 0 ? null : `N${Math.floor((i - 1) / fanout)}`;
    tree.push({
      id: `N${i}`,
      parentId,
      depth,
      kind: depth === 0 ? 'epic' : depth === 1 ? 'task' : 'subtask',
      status: 'pending',
      title: `Node ${i}`,
      metadata: { note: `synthetic-${i}` },
    });
  }
  return {
    kind: 'tree',
    data: {
      tree,
      root: 'N0',
      totalNodes: nodes,
      maxDepth: Math.ceil(Math.log(nodes) / Math.log(fanout)),
    },
  };
}

function measure<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

describe('renderEnvelopeForHuman perf budget (E11 ADR-077)', () => {
  it('table 100 rows < 30ms', () => {
    const env = buildTable(100);
    const { ms } = measure(() => renderEnvelopeForHuman(env, 'perf.table.100', {}));
    expect(ms, `table 100 rows exceeded 30ms budget: actual ${ms.toFixed(2)}ms`).toBeLessThan(30);
  });

  it('table 1000 rows < 100ms', () => {
    const env = buildTable(1000);
    const { ms } = measure(() => renderEnvelopeForHuman(env, 'perf.table.1k', {}));
    expect(ms, `table 1000 rows exceeded 100ms budget: actual ${ms.toFixed(2)}ms`).toBeLessThan(
      100,
    );
  });

  it('table 10000 rows < 500ms', () => {
    const env = buildTable(10000);
    const { ms } = measure(() => renderEnvelopeForHuman(env, 'perf.table.10k', {}));
    expect(ms, `table 10000 rows exceeded 500ms budget: actual ${ms.toFixed(2)}ms`).toBeLessThan(
      500,
    );
  });

  it('tree 100 nodes < 50ms', () => {
    const env = buildTree(100);
    const { ms } = measure(() => renderEnvelopeForHuman(env, 'perf.tree.100', {}));
    expect(ms, `tree 100 nodes exceeded 50ms budget: actual ${ms.toFixed(2)}ms`).toBeLessThan(50);
  });

  it('tree 1000 nodes < 200ms', () => {
    const env = buildTree(1000);
    const { ms } = measure(() => renderEnvelopeForHuman(env, 'perf.tree.1k', {}));
    expect(ms, `tree 1000 nodes exceeded 200ms budget: actual ${ms.toFixed(2)}ms`).toBeLessThan(
      200,
    );
  });
});
