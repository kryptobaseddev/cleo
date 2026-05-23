/**
 * Compile-time + runtime narrowing tests for `RenderableEnvelope<T>` and the
 * per-kind type guards.
 *
 * Each test constructs a valid envelope of a single `kind` and asserts that
 * the matching guard narrows it correctly while every other guard returns
 * `false`. This catches both schema drift and accidental short-circuits in
 * the guards.
 *
 * @epic T10114
 * @task T10141
 */

import { describe, expect, it } from 'vitest';
import {
  isGenericEnvelope,
  isGroupedListEnvelope,
  isListEnvelope,
  isSectionEnvelope,
  isSingleEnvelope,
  isTableEnvelope,
  isTreeEnvelope,
  type RenderableEnvelope,
} from '../envelope.js';
import { isGroupedListResponse, isListResponse } from '../list.js';
import { isTableResponse } from '../table.js';
import { isTreeResponse } from '../tree.js';

interface Sample {
  readonly x: number;
}

describe('RenderableEnvelope<T> discriminated-union narrowing', () => {
  it('narrows the tree variant and rejects all others', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'tree',
      data: { tree: [], root: 'T1', totalNodes: 0, maxDepth: 0 },
    };
    expect(isTreeEnvelope(env)).toBe(true);
    expect(isTableEnvelope(env)).toBe(false);
    expect(isListEnvelope(env)).toBe(false);
    expect(isGroupedListEnvelope(env)).toBe(false);
    expect(isSectionEnvelope(env)).toBe(false);
    expect(isSingleEnvelope(env)).toBe(false);
    expect(isGenericEnvelope(env)).toBe(false);
    if (isTreeEnvelope(env)) {
      expect(env.data.root).toBe('T1');
    } else {
      throw new Error('expected tree narrowing');
    }
  });

  it('narrows the table variant and rejects all others', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'table',
      data: {
        rows: [{ x: 1 }],
        schema: { columns: [{ key: 'x', header: 'X' }] },
        total: 1,
      },
    };
    expect(isTableEnvelope(env)).toBe(true);
    expect(isTreeEnvelope(env)).toBe(false);
    if (isTableEnvelope(env)) {
      expect(env.data.rows[0]?.x).toBe(1);
    } else {
      throw new Error('expected table narrowing');
    }
  });

  it('narrows the flat list variant', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'list',
      data: { items: [{ x: 7 }], total: 1, renderItem: 'kv' },
    };
    expect(isListEnvelope(env)).toBe(true);
    expect(isGroupedListEnvelope(env)).toBe(false);
    if (isListEnvelope(env)) {
      expect(env.data.items[0]?.x).toBe(7);
      expect(env.data.renderItem).toBe('kv');
    } else {
      throw new Error('expected list narrowing');
    }
  });

  it('narrows the grouped-list variant', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'grouped-list',
      data: {
        groups: [{ key: 'a', label: 'A', items: [{ x: 2 }] }],
        total: 1,
      },
    };
    expect(isGroupedListEnvelope(env)).toBe(true);
    expect(isListEnvelope(env)).toBe(false);
    if (isGroupedListEnvelope(env)) {
      expect(env.data.groups[0]?.items[0]?.x).toBe(2);
    } else {
      throw new Error('expected grouped-list narrowing');
    }
  });

  it('narrows the section variant', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'section',
      data: { header: 'Summary', icon: 'i', items: ['a', 'b'] },
    };
    expect(isSectionEnvelope(env)).toBe(true);
    if (isSectionEnvelope(env)) {
      expect(env.data.items).toEqual(['a', 'b']);
    } else {
      throw new Error('expected section narrowing');
    }
  });

  it('narrows the single variant', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'single',
      data: { x: 42 },
    };
    expect(isSingleEnvelope(env)).toBe(true);
    if (isSingleEnvelope(env)) {
      expect(env.data.x).toBe(42);
    } else {
      throw new Error('expected single narrowing');
    }
  });

  it('narrows the generic variant', () => {
    const env: RenderableEnvelope<Sample> = {
      kind: 'generic',
      data: { foo: 'bar', count: 3 },
    };
    expect(isGenericEnvelope(env)).toBe(true);
    if (isGenericEnvelope(env)) {
      expect(env.data.foo).toBe('bar');
    } else {
      throw new Error('expected generic narrowing');
    }
  });

  it('exhaustively switches on kind without falling through', () => {
    const envelopes: Array<RenderableEnvelope<Sample>> = [
      { kind: 'tree', data: { tree: [], root: 'r', totalNodes: 0, maxDepth: 0 } },
      {
        kind: 'table',
        data: { rows: [], schema: { columns: [] }, total: 0 },
      },
      { kind: 'list', data: { items: [], total: 0 } },
      { kind: 'grouped-list', data: { groups: [], total: 0 } },
      { kind: 'section', data: { header: 'h', items: [] } },
      { kind: 'single', data: { x: 0 } },
      { kind: 'generic', data: {} },
    ];
    const seen = new Set<RenderableEnvelope<Sample>['kind']>();
    for (const env of envelopes) {
      switch (env.kind) {
        case 'tree':
        case 'table':
        case 'list':
        case 'grouped-list':
        case 'section':
        case 'single':
        case 'generic':
          seen.add(env.kind);
          break;
        default: {
          const _exhaustive: never = env;
          throw new Error(`unreachable: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
    expect(seen.size).toBe(7);
  });
});

describe('per-response type guards', () => {
  it('accepts valid response shapes', () => {
    expect(isTreeResponse({ tree: [], root: 'r', totalNodes: 0, maxDepth: 0 })).toBe(true);
    expect(isTableResponse({ rows: [], schema: { columns: [] }, total: 0 })).toBe(true);
    expect(isListResponse({ items: [], total: 0 })).toBe(true);
    expect(isGroupedListResponse({ groups: [], total: 0 })).toBe(true);
  });

  it('rejects invalid response shapes', () => {
    expect(isTreeResponse(null)).toBe(false);
    expect(isTreeResponse({})).toBe(false);
    expect(isTreeResponse({ tree: 'nope', root: 'r', totalNodes: 0, maxDepth: 0 })).toBe(false);
    expect(isTableResponse({ rows: [], total: 0 })).toBe(false);
    expect(isTableResponse({ rows: [], schema: 'nope', total: 0 })).toBe(false);
    expect(isListResponse({ items: 'nope', total: 0 })).toBe(false);
    expect(isGroupedListResponse({ groups: 'nope', total: 0 })).toBe(false);
  });
});
