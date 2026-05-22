/**
 * Contract types for the renderTaskTree SDK tools.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional
 * @task T10068
 * @epic T9835
 */

import type { CriticalPathEdge, CriticalPathNode } from './compute-critical-path.js';

/** Input to both text and Mermaid renderers. */
export interface RenderTaskTreeInput {
  /** Task nodes to render. */
  nodes: CriticalPathNode[];
  /** Directed edges between nodes. */
  edges: CriticalPathEdge[];
  /** Task IDs on the critical path (highlighted in output). */
  criticalPath: string[];
}
