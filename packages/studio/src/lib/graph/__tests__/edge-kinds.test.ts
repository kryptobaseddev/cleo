/**
 * Unit tests for the canonical edge-kind taxonomy.
 *
 * Guards the invariant that every {@link EdgeKind} variant has a
 * matching entry in {@link EDGE_STYLE} and a describeFn — both are
 * consumed by the renderer + legend dock.
 *
 * @task T990
 * @wave 1A
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_EDGE_KINDS,
  describeEdgeKind,
  EDGE_STYLE,
  invalidateEdgeStyleCache,
  resolveEdgeStyleForWebGL,
} from '../edge-kinds.js';
import type { EdgeKind } from '../types.js';

describe('EDGE_STYLE', () => {
  it('has an entry for every variant in ALL_EDGE_KINDS', () => {
    for (const kind of ALL_EDGE_KINDS) {
      expect(EDGE_STYLE[kind]).toBeDefined();
      expect(typeof EDGE_STYLE[kind].color).toBe('string');
      expect(EDGE_STYLE[kind].color.length).toBeGreaterThan(0);
      expect(EDGE_STYLE[kind].thickness).toBeGreaterThan(0);
    }
  });

  it('contains no raw hex colours — everything flows through tokens', () => {
    const forbidden = /#[0-9a-f]{6}/i;
    for (const kind of ALL_EDGE_KINDS) {
      expect(EDGE_STYLE[kind].color).not.toMatch(forbidden);
    }
  });

  it('marks only the two runtime synapse kinds as animated', () => {
    const animated = ALL_EDGE_KINDS.filter((k) => EDGE_STYLE[k].animated === true);
    expect(new Set(animated)).toEqual(new Set<EdgeKind>(['fires', 'co_fires']));
  });
});

describe('describeEdgeKind', () => {
  it('returns a non-empty human-readable string for every kind', () => {
    for (const kind of ALL_EDGE_KINDS) {
      const desc = describeEdgeKind(kind);
      expect(desc).toBeTruthy();
      expect(desc.length).toBeGreaterThan(2);
    }
  });
});

describe('resolveEdgeStyleForWebGL', () => {
  it('returns a neutral grey fallback in node-env (no document)', () => {
    invalidateEdgeStyleCache();
    const rgb = resolveEdgeStyleForWebGL('calls');
    expect(rgb).toHaveLength(3);
    expect(rgb[0]).toBeGreaterThanOrEqual(0);
    expect(rgb[0]).toBeLessThanOrEqual(1);
  });
});
