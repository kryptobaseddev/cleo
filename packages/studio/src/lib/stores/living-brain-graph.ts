/**
 * Shared Graphology instance store for the Living Brain canvas.
 * Both 2D (Sigma) and 3D (ForceGraph3D) renderers read from this store
 * to share layout positions and avoid duplicate API calls.
 */

import type Graph from 'graphology';
import { writable } from 'svelte/store';

/**
 * Singleton store holding the current Graphology instance.
 * Null when no graph is loaded or after component unmount.
 * Updated by LivingBrainGraph.svelte when building/rebuilding the graph.
 */
export const livingBrainGraphStore = writable<Graph | null>(null);
