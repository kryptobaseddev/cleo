/**
 * Shared Sigma 3 renderer configuration for CLEO Studio graph components.
 *
 * Both NexusGraph and LivingBrainGraph use these settings so rendering
 * behaviour (edge programs, label styling, zoom thresholds) stays
 * consistent across views.
 *
 * Sigma 3 ships `arrow` and `line` in its default `edgeProgramClasses`,
 * so no extra imports are required.  We keep `defaultEdgeType: 'arrow'`
 * for directed call-graphs and expose `LINE_EDGE_TYPE` for callers that
 * prefer simple undirected rendering.
 *
 * @module lib/components/sigma-defaults
 */

import type { Settings } from 'sigma/settings';

/** Edge type constant – arrow head (directed, call-graph default). */
export const ARROW_EDGE_TYPE = 'arrow' as const;

/** Edge type constant – flat rectangle (lighter, undirected rendering). */
export const LINE_EDGE_TYPE = 'line' as const;

/**
 * Base Sigma settings shared across all graph components.
 *
 * Callers should spread these and override individual keys where needed
 * (e.g. `labelRenderedSizeThreshold`).
 *
 * @example
 * ```ts
 * new Sigma(graph, container, {
 *   ...BASE_SIGMA_SETTINGS,
 *   labelRenderedSizeThreshold: 6,
 * });
 * ```
 */
export const BASE_SIGMA_SETTINGS: Partial<Settings> = {
  renderEdgeLabels: false,
  defaultEdgeType: ARROW_EDGE_TYPE,
  labelFont: 'monospace',
  labelSize: 11,
  zIndex: true,
  // labelRenderedSizeThreshold should be tuned per-component
};
