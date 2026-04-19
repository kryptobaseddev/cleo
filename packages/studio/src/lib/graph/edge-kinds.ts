/**
 * CLEO Studio — canonical edge-kind taxonomy.
 *
 * Every {@link EdgeKind} has a single style descriptor
 * ({@link EDGE_STYLE}) and a human-readable describeFn
 * ({@link describeEdgeKind}). The WebGL renderer resolves styles to
 * concrete RGB via {@link resolveEdgeStyleForWebGL} — which reads
 * `getComputedStyle(:root)` so theme swaps flow through without a
 * recompile.
 *
 * All colours are expressed as CSS custom-property references
 * (`var(--…)`) or `color-mix()` composites of the locked
 * `tokens.css` palette. NO hex literals live in this file.
 *
 * @task T990
 * @wave 1A
 */

import type { EdgeKind } from './types.js';

/**
 * Descriptor for how an edge of a given kind is drawn.
 *
 * `color` is always a CSS expression the browser can resolve against
 * `:root` — either a `var(--token)` reference or a `color-mix()`
 * composite of tokens. Never a raw hex.
 */
export interface EdgeStyle {
  /** CSS colour expression resolvable against `:root`. */
  color: string;
  /** Optional dash pattern — SVG-style `"4 2"` or `"2 4"`. */
  dash?: string;
  /** True when the edge draws an arrowhead at the target. */
  arrow?: boolean;
  /** Line thickness in CSS px at unit zoom. */
  thickness: number;
  /**
   * When true, the renderer animates travelling sparks along the edge
   * even in the absence of explicit `fires` events. Reserved for the
   * two runtime synapse kinds (`fires`, `co_fires`).
   */
  animated?: boolean;
}

/**
 * The edge-style table. Every {@link EdgeKind} variant MUST be present
 * — the edge-kinds.test.ts unit enforces that invariant at build time.
 */
export const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  /* -----------------------------------------------------------------
   * Hierarchy / structure — consume `--edge-structural` family.
   * --------------------------------------------------------------- */
  parent: { color: 'var(--edge-structural)', thickness: 1, arrow: true },
  contains: { color: 'var(--edge-structural)', thickness: 1, arrow: true },
  has_method: { color: 'var(--edge-structural-soft)', thickness: 1, arrow: true },
  has_property: { color: 'var(--edge-structural-soft)', thickness: 1, arrow: true },
  member_of: { color: 'var(--edge-structural)', thickness: 1, arrow: true },

  /* -----------------------------------------------------------------
   * Code — call / extends / implements / imports / accesses / defines.
   * --------------------------------------------------------------- */
  calls: { color: 'var(--edge-call)', thickness: 1.5, arrow: true },
  extends: { color: 'var(--edge-extends)', thickness: 1.5, arrow: true },
  implements: { color: 'var(--edge-implements)', thickness: 1.5, arrow: true },
  imports: { color: 'var(--edge-import)', thickness: 1, arrow: true },
  accesses: { color: 'var(--edge-import-soft)', thickness: 1, arrow: true },
  defines: { color: 'var(--edge-definition)', thickness: 1.2, arrow: true },

  /* -----------------------------------------------------------------
   * Tasks — blocks (dashed workflow red), depends (dotted workflow-soft amber).
   * --------------------------------------------------------------- */
  blocks: { color: 'var(--edge-workflow)', dash: '6 3', thickness: 1.5, arrow: true },
  depends: { color: 'var(--edge-workflow-soft)', dash: '2 3', thickness: 1.5, arrow: true },

  /* -----------------------------------------------------------------
   * Memory provenance.
   * --------------------------------------------------------------- */
  supersedes: { color: 'var(--edge-knowledge)', dash: '6 3', thickness: 1.8, arrow: true },
  contradicts: { color: 'var(--edge-contradicts)', dash: '4 2', thickness: 1.8, arrow: true },
  derived_from: { color: 'var(--edge-knowledge-soft)', thickness: 1.4, arrow: true },
  produced_by: { color: 'var(--edge-knowledge-soft)', thickness: 1.2, arrow: true },
  informed_by: { color: 'var(--edge-knowledge-soft)', thickness: 1.2, arrow: true },
  references: { color: 'var(--edge-citation)', thickness: 1, arrow: false },
  cites: { color: 'var(--edge-citation)', dash: '2 3', thickness: 1, arrow: false },
  documents: { color: 'var(--edge-citation-soft)', thickness: 1.2, arrow: true },

  /* -----------------------------------------------------------------
   * Runtime — glowing synapse fires + messages.
   * --------------------------------------------------------------- */
  fires: { color: 'var(--edge-fires)', thickness: 1.4, arrow: false, animated: true },
  co_fires: { color: 'var(--edge-cofires)', thickness: 1.2, arrow: false, animated: true },
  messages: { color: 'var(--edge-messages)', thickness: 1, arrow: true },

  /* -----------------------------------------------------------------
   * Fallback — dim-slate, no arrow.
   * --------------------------------------------------------------- */
  relates_to: { color: 'var(--edge-relates)', thickness: 0.8, arrow: false },
};

/**
 * Short human-readable description for an edge kind. Consumed by the
 * legend dock and keyboard-accessible side-panel.
 *
 * @param kind - Canonical edge kind.
 */
export function describeEdgeKind(kind: EdgeKind): string {
  switch (kind) {
    case 'parent':
      return 'Parent of (hierarchy)';
    case 'contains':
      return 'Contains (hierarchy)';
    case 'has_method':
      return 'Has method';
    case 'has_property':
      return 'Has property';
    case 'member_of':
      return 'Member of';
    case 'calls':
      return 'Calls (function invocation)';
    case 'extends':
      return 'Extends (class hierarchy)';
    case 'implements':
      return 'Implements (interface)';
    case 'imports':
      return 'Imports module';
    case 'accesses':
      return 'Accesses property / field';
    case 'defines':
      return 'Defines symbol';
    case 'blocks':
      return 'Blocks (task cannot start)';
    case 'depends':
      return 'Depends on (task dependency)';
    case 'supersedes':
      return 'Supersedes (memory lineage)';
    case 'contradicts':
      return 'Contradicts (memory conflict)';
    case 'derived_from':
      return 'Derived from';
    case 'produced_by':
      return 'Produced by';
    case 'informed_by':
      return 'Informed by';
    case 'references':
      return 'References';
    case 'cites':
      return 'Cites';
    case 'documents':
      return 'Documents';
    case 'fires':
      return 'Synapse fires';
    case 'co_fires':
      return 'Co-fires (Hebbian)';
    case 'messages':
      return 'Conduit message';
    case 'relates_to':
      return 'Relates to (generic)';
  }
}

/**
 * Resolver cache — populated lazily by {@link resolveEdgeStyleForWebGL}
 * once per render loop. Key = edge kind, value = `[r,g,b]` linear-ish
 * RGB tuple in the `[0,1]` range.
 */
const webglRgbCache = new Map<EdgeKind, [number, number, number]>();

/**
 * Reset the WebGL colour cache. Call this on theme swap so the next
 * {@link resolveEdgeStyleForWebGL} invocation re-reads computed styles.
 */
export function invalidateEdgeStyleCache(): void {
  webglRgbCache.clear();
}

/**
 * Parse a CSS `rgb()` / `rgba()` / `#rrggbb` string into `[r,g,b]` in
 * the `[0,1]` range. Rejects anything else with a fallback to white.
 *
 * The browser always serialises computed `getComputedStyle` values
 * into `rgb()` / `rgba()` form (per CSS Color 4), so a single parser
 * covers both `var(--token)` references AND `color-mix()` composites.
 *
 * @param css - CSS colour string resolved by the browser.
 */
function parseCssColorToRgb01(css: string): [number, number, number] {
  const trimmed = css.trim();
  const rgbMatch = /rgba?\(([^)]+)\)/i.exec(trimmed);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[,\s/]+/).filter((p) => p.length > 0);
    if (parts.length >= 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return [r / 255, g / 255, b / 255];
      }
    }
  }
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1];
    return [
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255,
    ];
  }
  // Opaque white fallback so edges are at least visible on failure.
  return [1, 1, 1];
}

/**
 * Resolve an edge kind to an `[r,g,b]` tuple in the `[0,1]` range for
 * use as THREE.js vertex colour / shader uniform.
 *
 * Reads from `getComputedStyle(:root)` so every token swap (theme
 * change, prefers-contrast, etc.) flows through without a rebuild.
 * The result is memoised — call {@link invalidateEdgeStyleCache} on
 * theme change.
 *
 * Safe to call in SSR: returns a neutral grey when `document` is
 * unavailable.
 *
 * @param kind - Canonical edge kind.
 */
export function resolveEdgeStyleForWebGL(kind: EdgeKind): [number, number, number] {
  const cached = webglRgbCache.get(kind);
  if (cached !== undefined) return cached;

  // SSR / test fallback
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return [0.5, 0.5, 0.5];
  }

  const style = EDGE_STYLE[kind];
  // Create a throw-away element to resolve `var(--…)` / `color-mix(…)`.
  const probe = document.createElement('span');
  probe.style.color = style.color;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe).color;
  document.body.removeChild(probe);

  const rgb = parseCssColorToRgb01(computed);
  webglRgbCache.set(kind, rgb);
  return rgb;
}

/**
 * Ordered list of every edge kind — consumers use this to iterate in a
 * stable order (legend dock, tests, docs).
 */
export const ALL_EDGE_KINDS: readonly EdgeKind[] = [
  'parent',
  'contains',
  'has_method',
  'has_property',
  'member_of',
  'calls',
  'extends',
  'implements',
  'imports',
  'accesses',
  'defines',
  'blocks',
  'depends',
  'supersedes',
  'contradicts',
  'derived_from',
  'produced_by',
  'informed_by',
  'references',
  'cites',
  'documents',
  'fires',
  'co_fires',
  'messages',
  'relates_to',
] as const;
