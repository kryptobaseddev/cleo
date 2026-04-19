/**
 * CLEO Studio — "no face-up leaf labels" guard.
 *
 * Operator mandate (T990 directive): leaf nodes MUST NOT carry SpriteText
 * or any always-facing-camera label. Only hub / category nodes receive
 * CSS2DRenderer-backed labels. This module provides a type-level and
 * runtime check so the renderer can't accidentally ship a config that
 * enables `drawLabels`/`renderLabels`.
 *
 * The reference GitNexus viz deliberately hides leaf labels and surfaces
 * names only through hover cards + community cluster captions — keeping
 * dense graphs readable at macro zoom.
 *
 * @task T990
 * @wave 1A
 */

/**
 * Config object shape the guard accepts. Only the two properties that
 * matter are typed — any unrelated fields pass through untouched.
 */
export interface NoFaceUpOptions {
  /**
   * Whether the renderer is currently configured to draw per-node
   * labels. MUST be `false` (or absent) for the CLEO Studio macro +
   * community + ego views. Cluster label overlays are handled by the
   * separate `ClusterLabelLayer` component and are allowed.
   */
  drawLabels?: boolean;
  /** Alias of `drawLabels` used by some legacy 3d-force-graph configs. */
  renderLabels?: boolean;
}

/**
 * Thrown when a renderer config would enable face-up leaf labels.
 */
export class FaceUpLabelsForbiddenError extends Error {
  constructor(field: 'drawLabels' | 'renderLabels') {
    super(
      `Face-up leaf labels are forbidden by the T990 spec ` +
        `(operator directive: cluster-labels only via CSS2DRenderer). ` +
        `Offending config field: "${field}".`,
    );
    this.name = 'FaceUpLabelsForbiddenError';
  }
}

/**
 * Runtime + narrowing assertion that a renderer config does NOT enable
 * face-up leaf labels.
 *
 * Rejects:
 *   - `{ drawLabels: true }`
 *   - `{ renderLabels: true }`
 *
 * Accepts `undefined` / `false` on both — those are the only two
 * permitted values for a compliant renderer config.
 *
 * Called from every renderer's `onMount` after config resolution. The
 * thrown error is caught by the renderer and surfaced via its
 * `onInitFailed` callback so the parent page can degrade to the SVG
 * fallback without wedging the UI.
 *
 * @param opts - Candidate renderer config. Any shape; only
 *   `drawLabels` + `renderLabels` are examined.
 * @throws {@link FaceUpLabelsForbiddenError} when either forbidden
 *   field is `true`.
 */
export function assertNoFaceUp(
  opts: unknown,
): asserts opts is NoFaceUpOptions & { drawLabels?: false; renderLabels?: false } {
  if (opts === null || typeof opts !== 'object') return;
  const c = opts as Record<string, unknown>;
  if (c.drawLabels === true) {
    throw new FaceUpLabelsForbiddenError('drawLabels');
  }
  if (c.renderLabels === true) {
    throw new FaceUpLabelsForbiddenError('renderLabels');
  }
}
