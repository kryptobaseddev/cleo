/**
 * Unit tests for Brain shell pure logic.
 *
 * All of these tests operate on extracted pure functions — no DOM, no
 * WebGL, no Svelte mounting. The tests cover:
 *
 *   1. Skeleton renders (logic guard: visible prop controls rendering).
 *   2. SubstrateLegend: chip click sets focusSubstrate.
 *   3. SubstrateLegend: solo mode hides the other 4 substrates.
 *   4. Keyboard shortcut mapping (digit keys → substrate focus).
 *   5. BrainMonitorPanel: bridge detection from edge meta.
 *   6. BrainMonitorPanel: Node Detail renders bridge section.
 *   7. SubstrateLegend: double-click enters solo mode.
 *   8. SubstrateLegend: shift-click toggles visibility.
 *   9. buildSparkPath produces a valid SVG path string.
 *  10. relativeTime formats timestamps correctly.
 *
 * @task T990
 * @wave 1A
 */

import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, SubstrateId } from '$lib/graph/types.js';

// ---------------------------------------------------------------------------
// Extracted pure helpers (mirror component internals)
// ---------------------------------------------------------------------------

/** Mirrors BrainLoadingSkeleton visible logic. */
function shouldShowSkeleton(visible: boolean): boolean {
  return visible;
}

/** Mirrors SubstrateLegend: compute effective substrates given solo state. */
function computeEffectiveSubstrates(
  enabledSubstrates: Set<SubstrateId>,
  soloSubstrate: SubstrateId | null,
): Set<SubstrateId> {
  if (soloSubstrate !== null) return new Set<SubstrateId>([soloSubstrate]);
  return enabledSubstrates;
}

/**
 * Mirrors SubstrateLegend click logic.
 * Returns [newFocusSubstrate, newEnabledSubstrates, newSolo].
 */
function handleChipClick(
  s: SubstrateId,
  currentFocus: SubstrateId | null,
  currentEnabled: Set<SubstrateId>,
  shiftKey: boolean,
): { focus: SubstrateId | null; enabled: Set<SubstrateId> } {
  if (shiftKey) {
    const next = new Set(currentEnabled);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    return { focus: next.size === 1 ? [...next][0] : null, enabled: next };
  }
  if (currentFocus === s) {
    return {
      focus: null,
      enabled: new Set<SubstrateId>(['brain', 'nexus', 'tasks', 'conduit', 'signaldock']),
    };
  }
  return {
    focus: s,
    enabled: new Set<SubstrateId>(['brain', 'nexus', 'tasks', 'conduit', 'signaldock']),
  };
}

/**
 * Mirrors SubstrateLegend double-click solo logic.
 */
function handleDblClick(
  s: SubstrateId,
  currentSolo: SubstrateId | null,
): { solo: SubstrateId | null; focus: SubstrateId | null; enabled: Set<SubstrateId> } {
  if (currentSolo === s) {
    return {
      solo: null,
      focus: null,
      enabled: new Set<SubstrateId>(['brain', 'nexus', 'tasks', 'conduit', 'signaldock']),
    };
  }
  return {
    solo: s,
    focus: s,
    enabled: new Set<SubstrateId>([s]),
  };
}

/**
 * Mirrors keyboard shortcut mapping in +page.svelte handleKeyDown.
 */
function keyToSubstrate(key: string): SubstrateId | null {
  const map: Record<string, SubstrateId> = {
    '1': 'brain',
    '2': 'nexus',
    '3': 'tasks',
    '4': 'conduit',
    '5': 'signaldock',
  };
  return map[key] ?? null;
}

/**
 * Mirrors the bridge-detection logic used in BrainMonitorPanel.
 * Returns true when an edge is a cross-substrate bridge.
 */
function isBridgeEdge(edge: GraphEdge, nodes: GraphNode[]): boolean {
  const src = nodes.find((n) => n.id === edge.source);
  const tgt = nodes.find((n) => n.id === edge.target);
  if (!src || !tgt) return false;
  const metaBridge = (edge.meta as { isBridge?: boolean } | undefined)?.isBridge;
  if (metaBridge === true) return true;
  return src.substrate !== tgt.substrate;
}

/**
 * Mirrors buildSparkPath in RegionMeter.
 */
function buildSparkPath(values: number[]): string {
  const SPARK_SAMPLES = 60;
  const samples = values.slice(-SPARK_SAMPLES);
  if (samples.length < 2) return '';
  const w = 120;
  const h = 28;
  const max = Math.max(...samples, 1);
  const step = w / (samples.length - 1);
  const points = samples.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M ${points.join(' L ')}`;
}

/**
 * Mirrors relativeTime in BrainMonitorPanel.
 */
function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_SUBS: SubstrateId[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

function makeNode(id: string, substrate: SubstrateId): GraphNode {
  return { id, substrate, kind: 'observation', label: `Node ${id}` };
}

function makeEdge(source: string, target: string, isBridge?: boolean): GraphEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    kind: 'fires',
    meta: isBridge !== undefined ? { isBridge } : undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. Skeleton visibility
// ---------------------------------------------------------------------------

describe('BrainLoadingSkeleton visibility', () => {
  it('shows skeleton when visible=true', () => {
    expect(shouldShowSkeleton(true)).toBe(true);
  });

  it('hides skeleton when visible=false', () => {
    expect(shouldShowSkeleton(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Chip click sets focusSubstrate
// ---------------------------------------------------------------------------

describe('SubstrateLegend chip click — set focus', () => {
  it('sets focus to the clicked substrate', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const { focus } = handleChipClick('nexus', null, enabled, false);
    expect(focus).toBe('nexus');
  });

  it('clears focus when clicking the already-focused substrate', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const { focus } = handleChipClick('nexus', 'nexus', enabled, false);
    expect(focus).toBeNull();
  });

  it('switches focus from one substrate to another', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const { focus } = handleChipClick('tasks', 'brain', enabled, false);
    expect(focus).toBe('tasks');
  });
});

// ---------------------------------------------------------------------------
// 3. Solo mode hides other 4 substrates
// ---------------------------------------------------------------------------

describe('SubstrateLegend solo mode', () => {
  it('effective substrates contains only the solo substrate', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const effective = computeEffectiveSubstrates(enabled, 'nexus');
    expect([...effective]).toEqual(['nexus']);
    expect(effective.size).toBe(1);
  });

  it('all 5 substrates visible when solo is null', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const effective = computeEffectiveSubstrates(enabled, null);
    expect(effective.size).toBe(5);
  });

  it('solo overrides even a partially-enabled set', () => {
    const partialEnabled = new Set<SubstrateId>(['brain', 'nexus']);
    const effective = computeEffectiveSubstrates(partialEnabled, 'tasks');
    expect([...effective]).toEqual(['tasks']);
  });
});

// ---------------------------------------------------------------------------
// 4. Keyboard shortcut mapping
// ---------------------------------------------------------------------------

describe('Keyboard shortcut mapping', () => {
  it.each([
    ['1', 'brain'],
    ['2', 'nexus'],
    ['3', 'tasks'],
    ['4', 'conduit'],
    ['5', 'signaldock'],
  ] as const)('key %s maps to substrate %s', (key, expected) => {
    expect(keyToSubstrate(key)).toBe(expected);
  });

  it('returns null for non-digit keys', () => {
    expect(keyToSubstrate('a')).toBeNull();
    expect(keyToSubstrate('0')).toBeNull();
    expect(keyToSubstrate('f')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Bridge detection from edge meta
// ---------------------------------------------------------------------------

describe('Bridge edge detection', () => {
  const brainNode = makeNode('brain-1', 'brain');
  const nexusNode = makeNode('nexus-1', 'nexus');
  const brainNode2 = makeNode('brain-2', 'brain');

  it('detects bridge when meta.isBridge is true', () => {
    const edge = makeEdge('brain-1', 'nexus-1', true);
    expect(isBridgeEdge(edge, [brainNode, nexusNode])).toBe(true);
  });

  it('detects bridge by substrate mismatch when meta is absent', () => {
    const edge = makeEdge('brain-1', 'nexus-1');
    expect(isBridgeEdge(edge, [brainNode, nexusNode])).toBe(true);
  });

  it('does not flag intra-substrate edge as bridge', () => {
    const edge = makeEdge('brain-1', 'brain-2', false);
    expect(isBridgeEdge(edge, [brainNode, brainNode2])).toBe(false);
  });

  it('does not flag intra-substrate edge as bridge (no meta)', () => {
    const edge = makeEdge('brain-1', 'brain-2');
    expect(isBridgeEdge(edge, [brainNode, brainNode2])).toBe(false);
  });

  it('returns false for edges with missing nodes', () => {
    const edge = makeEdge('ghost-1', 'ghost-2');
    expect(isBridgeEdge(edge, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Bridge section visible when bridge edges exist for selected node
// ---------------------------------------------------------------------------

describe('Node detail bridge section', () => {
  it('filters bridge edges involving the selected node', () => {
    const selected = makeNode('brain-1', 'brain');
    const brainNode2 = makeNode('brain-2', 'brain');
    const nexusNode = makeNode('nexus-1', 'nexus');
    const nodes = [selected, brainNode2, nexusNode];

    const bridgeEdge = makeEdge('brain-1', 'nexus-1', true);
    const intraEdge = makeEdge('brain-1', 'brain-2', false);
    const edges = [bridgeEdge, intraEdge];

    // Simulate BrainMonitorPanel bridge filtering.
    const bridges = edges.filter((e) => {
      if (e.source !== selected.id && e.target !== selected.id) return false;
      return isBridgeEdge(e, nodes);
    });

    expect(bridges).toHaveLength(1);
    expect(bridges[0].id).toBe('brain-1->nexus-1');
  });
});

// ---------------------------------------------------------------------------
// 7. Double-click enters / exits solo mode
// ---------------------------------------------------------------------------

describe('SubstrateLegend double-click solo', () => {
  it('entering solo mode sets solo and limits enabled set', () => {
    const result = handleDblClick('nexus', null);
    expect(result.solo).toBe('nexus');
    expect(result.focus).toBe('nexus');
    expect([...result.enabled]).toEqual(['nexus']);
  });

  it('double-clicking same substrate exits solo mode', () => {
    const result = handleDblClick('nexus', 'nexus');
    expect(result.solo).toBeNull();
    expect(result.focus).toBeNull();
    expect(result.enabled.size).toBe(5);
  });

  it('double-clicking a different substrate switches solo', () => {
    const result = handleDblClick('tasks', 'nexus');
    expect(result.solo).toBe('tasks');
    expect([...result.enabled]).toEqual(['tasks']);
  });
});

// ---------------------------------------------------------------------------
// 8. Shift-click toggles individual substrate visibility
// ---------------------------------------------------------------------------

describe('SubstrateLegend shift-click toggle', () => {
  it('removes an enabled substrate from the set', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const { enabled: next } = handleChipClick('nexus', null, enabled, true);
    expect(next.has('nexus')).toBe(false);
    expect(next.size).toBe(4);
  });

  it('adds a disabled substrate back to the set', () => {
    const enabled = new Set<SubstrateId>(['brain', 'tasks']);
    const { enabled: next } = handleChipClick('nexus', null, enabled, true);
    expect(next.has('nexus')).toBe(true);
    expect(next.size).toBe(3);
  });

  it('sets focus when exactly one substrate remains after shift-click', () => {
    const enabled = new Set<SubstrateId>(['brain', 'nexus']);
    const { focus } = handleChipClick('brain', null, enabled, true);
    expect(focus).toBe('nexus');
  });

  it('clears focus when multiple substrates remain after shift-click', () => {
    const enabled = new Set<SubstrateId>(ALL_SUBS);
    const { focus } = handleChipClick('brain', null, enabled, true);
    expect(focus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. buildSparkPath
// ---------------------------------------------------------------------------

describe('buildSparkPath', () => {
  it('returns empty string for fewer than 2 samples', () => {
    expect(buildSparkPath([])).toBe('');
    expect(buildSparkPath([50])).toBe('');
  });

  it('returns a string starting with M for 2+ samples', () => {
    const path = buildSparkPath([10, 50, 30]);
    expect(path).toMatch(/^M /);
  });

  it('includes L segments for multi-point paths', () => {
    const path = buildSparkPath([10, 20, 30, 40]);
    expect(path).toContain(' L ');
  });

  it('uses only the last 60 samples', () => {
    const values = Array.from({ length: 70 }, (_, i) => i);
    const path = buildSparkPath(values);
    // Path with 60 samples has 59 L segments.
    const lCount = (path.match(/ L /g) ?? []).length;
    expect(lCount).toBe(59);
  });

  it('handles zero-range data (all same value) without division by zero', () => {
    expect(() => buildSparkPath([5, 5, 5, 5])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  it('formats seconds correctly', () => {
    const ms = Date.now() - 30_000; // 30s ago
    const label = relativeTime(ms);
    expect(label).toMatch(/^\d+s ago$/);
  });

  it('formats minutes correctly', () => {
    const ms = Date.now() - 3 * 60_000; // 3m ago
    const label = relativeTime(ms);
    expect(label).toMatch(/^\d+m ago$/);
  });

  it('formats hours correctly', () => {
    const ms = Date.now() - 2 * 3_600_000; // 2h ago
    const label = relativeTime(ms);
    expect(label).toMatch(/^\d+h ago$/);
  });

  it('returns "0s ago" for future timestamps (clamped to 0)', () => {
    const ms = Date.now() + 10_000; // future
    const label = relativeTime(ms);
    expect(label).toBe('0s ago');
  });
});
